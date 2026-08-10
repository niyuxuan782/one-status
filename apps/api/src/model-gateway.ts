import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ModelSource } from "@one-status/protocol";

const TOKEN_PREFIX = "osmg_v1";
const TOKEN_CONTEXT = "one-status:model-gateway:v1:";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const MAX_ERROR_BODY_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
export type GatewayProtocol =
  | "anthropic"
  | "openai-chat"
  | "openai-responses";

export interface ResolvedModelGatewaySource {
  apiKey?: string;
  source: Pick<
    ModelSource,
    "apiFormat" | "endpoint" | "id" | "kind" | "protocol"
  >;
}

export interface ModelGatewayOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  resolveSource(input: {
    sourceId: string;
    userId: string;
  }): Promise<ResolvedModelGatewaySource | undefined>;
  tokenAuthority: ModelGatewayTokenAuthority;
}

export interface ModelGatewayConfiguration {
  endpoint: string;
  protocol: GatewayProtocol;
  token: string;
}

interface GatewayTokenClaims {
  sourceId: string;
  userId: string;
  version: 1;
}

interface SseEvent {
  data: string;
  event?: string;
}

interface OpenAiUsage {
  completion_tokens_details?: { reasoning_tokens?: number };
  completion_tokens?: number;
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  total_tokens?: number;
}

export class ModelGatewayTokenAuthority {
  readonly #key: Buffer;

  constructor(options: { key?: Uint8Array; keyPath?: string }) {
    if (options.key) {
      if (options.key.byteLength < 32) {
        throw new Error("Model Gateway token key must contain at least 32 bytes.");
      }
      this.#key = Buffer.from(options.key);
      return;
    }
    if (!options.keyPath) {
      throw new Error("Model Gateway token key path is required.");
    }
    this.#key = loadOrCreateTokenKey(options.keyPath);
  }

  issue(input: { sourceId: string; userId: string }): string {
    const claims: GatewayTokenClaims = {
      sourceId: requiredSourceId(input.sourceId),
      userId: requiredClaim(input.userId, "userId", 500),
      version: 1,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = this.#sign(payload).toString("base64url");
    return `${TOKEN_PREFIX}.${payload}.${signature}`;
  }

  verify(token: string): GatewayTokenClaims | undefined {
    const [prefix, payload, signature, extra] = token.split(".");
    if (prefix !== TOKEN_PREFIX || !payload || !signature || extra) {
      return undefined;
    }
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      return undefined;
    }
    const expected = this.#sign(payload);
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) {
      return undefined;
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Partial<GatewayTokenClaims>;
      if (claims.version !== 1) return undefined;
      return {
        sourceId: requiredSourceId(claims.sourceId),
        userId: requiredClaim(claims.userId, "userId", 500),
        version: 1,
      };
    } catch {
      return undefined;
    }
  }

  #sign(payload: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(TOKEN_CONTEXT)
      .update(payload)
      .digest();
  }
}

export class ModelGateway {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #resolveSource: ModelGatewayOptions["resolveSource"];
  readonly #tokenAuthority: ModelGatewayTokenAuthority;

  constructor(options: ModelGatewayOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#resolveSource = options.resolveSource;
    this.#tokenAuthority = options.tokenAuthority;
  }

  configuration(input: {
    sourceId: string;
    targetProtocol: GatewayProtocol;
    userId: string;
  }): ModelGatewayConfiguration {
    const sourceId = requiredSourceId(input.sourceId);
    return {
      endpoint: `${this.#baseUrl}/v1/model-gateway/${encodeURIComponent(sourceId)}`,
      protocol: input.targetProtocol,
      token: this.#tokenAuthority.issue({
        sourceId,
        userId: input.userId,
      }),
    };
  }

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    incomingProtocol: GatewayProtocol,
  ): Promise<unknown> {
    let sourceId: string;
    try {
      sourceId = readSourceId(request.params);
    } catch {
      return gatewayError(reply, incomingProtocol, 404, "model_source_not_found", "The model source is unavailable.");
    }
    const token = readGatewayToken(request.headers);
    const claims = token ? this.#tokenAuthority.verify(token) : undefined;
    if (!claims || claims.sourceId !== sourceId) {
      return gatewayError(reply, incomingProtocol, 401, "invalid_api_key", "The Model Gateway credential is invalid.");
    }
    const resolved = await this.#resolveSource({
      sourceId,
      userId: claims.userId,
    });
    if (!resolved || resolved.source.id !== sourceId) {
      return gatewayError(reply, incomingProtocol, 404, "model_source_not_found", "The model source is unavailable.");
    }
    if (requiresCredential(resolved.source) && !resolved.apiKey) {
      return gatewayError(reply, incomingProtocol, 409, "model_credential_missing", "The model source credential is unavailable.");
    }

    const upstreamProtocol = protocolForSource(resolved.source);
    const endpoint = upstreamEndpoint(resolved.source, upstreamProtocol);
    if (!endpoint) {
      return gatewayError(reply, incomingProtocol, 422, "unsupported_model_source", "The model source protocol cannot be routed.");
    }

    const requestBody = asObject(request.body);
    const stream = requestBody.stream === true;
    const upstreamBody = gatewayRequestBody(
      incomingProtocol,
      upstreamProtocol,
      requestBody,
    );
    if (stream && upstreamProtocol === "openai-chat") {
      upstreamBody.stream_options = {
        ...asObject(upstreamBody.stream_options),
        include_usage: true,
      };
    }

    let upstream: Response;
    try {
      upstream = await this.#fetch(endpoint, {
        body: JSON.stringify(upstreamBody),
        headers: upstreamHeaders(
          resolved.source,
          upstreamProtocol,
          resolved.apiKey,
          request.headers,
        ),
        method: "POST",
      });
    } catch {
      return gatewayError(reply, incomingProtocol, 502, "upstream_unavailable", "The model provider could not be reached.");
    }

    copyResponseHeaders(upstream, reply);
    if (!upstream.ok) {
      return mapUpstreamError(
        upstream,
        reply,
        incomingProtocol,
        resolved.apiKey,
      );
    }
    if (stream) {
      if (!upstream.body) {
        return gatewayError(reply, incomingProtocol, 502, "invalid_upstream_response", "The model provider returned an empty stream.");
      }
      reply
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive")
        .type("text/event-stream; charset=utf-8");
      const output = gatewayResponseStream(
        incomingProtocol,
        upstreamProtocol,
        upstream.body,
        requestBody,
      );
      return reply.send(output);
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return gatewayError(reply, incomingProtocol, 502, "invalid_upstream_response", "The model provider returned invalid JSON.");
    }
    return gatewayResponseBody(
      incomingProtocol,
      upstreamProtocol,
      asObject(payload),
      requestBody,
    );
  }
}

export function registerModelGatewayRoutes(
  app: FastifyInstance,
  gateway: ModelGateway,
): void {
  const routes: Array<{ path: string; protocol: GatewayProtocol }> = [
    { path: "/v1/model-gateway/:sourceId/messages", protocol: "anthropic" },
    { path: "/v1/model-gateway/:sourceId/v1/messages", protocol: "anthropic" },
    { path: "/v1/model-gateway/:sourceId/chat/completions", protocol: "openai-chat" },
    { path: "/v1/model-gateway/:sourceId/v1/chat/completions", protocol: "openai-chat" },
    { path: "/v1/model-gateway/:sourceId/responses", protocol: "openai-responses" },
    { path: "/v1/model-gateway/:sourceId/v1/responses", protocol: "openai-responses" },
  ];
  for (const route of routes) {
    app.post(
      route.path,
      { logLevel: "silent" },
      (request, reply) => gateway.handle(request, reply, route.protocol),
    );
  }
}

function gatewayRequestBody(
  incoming: GatewayProtocol,
  upstream: GatewayProtocol,
  body: JsonObject,
): JsonObject {
  if (incoming === upstream) return body;
  const chatRequest = incoming === "anthropic"
    ? anthropicRequestToOpenAi(body)
    : incoming === "openai-responses"
      ? responsesRequestToOpenAi(body)
      : body;
  if (upstream === "anthropic") return openAiRequestToAnthropic(chatRequest);
  if (upstream === "openai-responses") {
    return openAiRequestToResponses(chatRequest);
  }
  return chatRequest;
}

function gatewayResponseBody(
  incoming: GatewayProtocol,
  upstream: GatewayProtocol,
  payload: JsonObject,
  request: JsonObject,
): JsonObject {
  if (incoming === upstream) return payload;
  const chatResponse = upstream === "anthropic"
    ? anthropicResponseToOpenAi(payload, request)
    : upstream === "openai-responses"
      ? responsesResponseToOpenAi(payload, request)
      : payload;
  if (incoming === "anthropic") {
    return openAiResponseToAnthropic(chatResponse, request);
  }
  if (incoming === "openai-responses") {
    return openAiResponseToResponses(chatResponse, request);
  }
  return chatResponse;
}

function gatewayResponseStream(
  incoming: GatewayProtocol,
  upstream: GatewayProtocol,
  body: ReadableStream<Uint8Array>,
  request: JsonObject,
): Readable {
  if (incoming === upstream) return Readable.fromWeb(body as never);
  const chatStream = upstream === "anthropic"
    ? textIterableToStream(anthropicStreamToOpenAi(body, request))
    : upstream === "openai-responses"
      ? textIterableToStream(responsesStreamToOpenAi(body, request))
      : body;
  if (incoming === "anthropic") {
    return Readable.from(openAiStreamToAnthropic(chatStream, request));
  }
  if (incoming === "openai-responses") {
    return Readable.from(openAiStreamToResponses(chatStream, request));
  }
  return Readable.fromWeb(chatStream as never);
}

export function responsesRequestToOpenAi(input: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  const instructions = stringValue(input.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  const inputItems =
    typeof input.input === "string"
      ? [{ role: "user", content: input.input }]
      : arrayValue(input.input);
  for (const itemValue of inputItems) {
    const item = asObject(itemValue);
    if (item.type === "function_call") {
      if (typeof item.name !== "string") continue;
      const toolCall = {
        id:
          stringValue(item.call_id) ??
          stringValue(item.id) ??
          `call_${randomBytes(12).toString("hex")}`,
        type: "function",
        function: {
          name: item.name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      };
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = stringValue(item.call_id);
      if (callId) {
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? ""),
        });
      }
      continue;
    }
    if (
      item.role === "system" ||
      item.role === "developer" ||
      item.role === "assistant" ||
      item.role === "user"
    ) {
      messages.push({
        role: item.role,
        content: responsesContentToOpenAi(item.content),
      });
    }
  }

  return compactObject({
    model: input.model,
    messages,
    max_tokens: input.max_output_tokens,
    temperature: input.temperature,
    top_p: input.top_p,
    stream: input.stream,
    tools: arrayValue(input.tools).flatMap((toolValue) => {
      const tool = asObject(toolValue);
      return tool.type === "function" && typeof tool.name === "string"
        ? [{
            type: "function",
            function: compactObject({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters ?? { type: "object", properties: {} },
              strict: tool.strict,
            }),
          }]
        : [];
    }),
    tool_choice: responsesToolChoiceToOpenAi(input.tool_choice),
    parallel_tool_calls: input.parallel_tool_calls,
    response_format: responsesTextFormat(input.text),
  });
}

export function openAiRequestToResponses(input: JsonObject): JsonObject {
  const instructions: string[] = [];
  const items: JsonObject[] = [];
  for (const messageValue of arrayValue(input.messages)) {
    const message = asObject(messageValue);
    if (message.role === "system" || message.role === "developer") {
      const text = openAiText(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (message.role === "tool") {
      const callId = stringValue(message.tool_call_id);
      if (callId) {
        items.push({
          type: "function_call_output",
          call_id: callId,
          output: openAiText(message.content),
        });
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = openAiContentToResponses(message.content, role);
    if (content.length > 0) {
      items.push({ type: "message", role, content });
    }
    if (role === "assistant") {
      for (const toolValue of arrayValue(message.tool_calls)) {
        const tool = asObject(toolValue);
        const function_ = asObject(tool.function);
        if (typeof function_.name !== "string") continue;
        const callId =
          stringValue(tool.id) ?? `call_${randomBytes(12).toString("hex")}`;
        items.push({
          type: "function_call",
          call_id: callId,
          name: function_.name,
          arguments:
            typeof function_.arguments === "string"
              ? function_.arguments
              : JSON.stringify(function_.arguments ?? {}),
        });
      }
    }
  }
  return compactObject({
    model: input.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input: items,
    max_output_tokens: input.max_tokens,
    temperature: input.temperature,
    top_p: input.top_p,
    stream: input.stream,
    store: false,
    tools: arrayValue(input.tools).flatMap((toolValue) => {
      const tool = asObject(toolValue);
      const function_ = asObject(tool.function);
      return tool.type === "function" && typeof function_.name === "string"
        ? [compactObject({
            type: "function",
            name: function_.name,
            description: function_.description,
            parameters:
              function_.parameters ?? { type: "object", properties: {} },
            strict: function_.strict,
          })]
        : [];
    }),
    tool_choice: openAiToolChoiceToResponses(input.tool_choice),
    parallel_tool_calls: input.parallel_tool_calls,
    text: openAiResponseFormatToResponses(input.response_format),
  });
}

export function responsesResponseToOpenAi(
  response: JsonObject,
  request: JsonObject,
): JsonObject {
  const text: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const itemValue of arrayValue(response.output)) {
    const item = asObject(itemValue);
    if (item.type === "message") {
      for (const partValue of arrayValue(item.content)) {
        const part = asObject(partValue);
        if (part.type === "output_text" && typeof part.text === "string") {
          text.push(part.text);
        }
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id:
          stringValue(item.call_id) ??
          stringValue(item.id) ??
          `call_${randomBytes(12).toString("hex")}`,
        type: "function",
        function: {
          name: item.name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  const usage = asObject(response.usage);
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  return {
    id:
      stringValue(response.id)?.replace(/^resp_/, "chatcmpl_") ??
      `chatcmpl_${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: numberValue(response.created_at) || Math.floor(Date.now() / 1_000),
    model: response.model ?? request.model ?? "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text.length > 0 ? text.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason:
        toolCalls.length > 0
          ? "tool_calls"
          : response.status === "incomplete"
            ? "length"
            : "stop",
      logprobs: null,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens:
        numberValue(usage.total_tokens) || inputTokens + outputTokens,
      prompt_tokens_details: {
        cached_tokens: numberValue(
          asObject(usage.input_tokens_details).cached_tokens,
        ),
      },
      completion_tokens_details: {
        reasoning_tokens: numberValue(
          asObject(usage.output_tokens_details).reasoning_tokens,
        ),
      },
    },
  };
}

export function openAiResponseToResponses(
  response: JsonObject,
  request: JsonObject,
): JsonObject {
  const choice = asObject(arrayValue(response.choices)[0]);
  const message = asObject(choice.message);
  const output: JsonObject[] = [];
  const text = openAiText(message.content);
  if (text || arrayValue(message.tool_calls).length === 0) {
    output.push({
      id: `msg_${randomBytes(12).toString("hex")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text,
        annotations: [],
        logprobs: [],
      }],
    });
  }
  for (const toolValue of arrayValue(message.tool_calls)) {
    const tool = asObject(toolValue);
    const function_ = asObject(tool.function);
    if (typeof function_.name !== "string") continue;
    output.push({
      id:
        stringValue(tool.id)?.replace(/^call_/, "fc_") ??
        `fc_${randomBytes(12).toString("hex")}`,
      type: "function_call",
      status: "completed",
      call_id:
        stringValue(tool.id) ?? `call_${randomBytes(12).toString("hex")}`,
      name: function_.name,
      arguments:
        typeof function_.arguments === "string"
          ? function_.arguments
          : JSON.stringify(function_.arguments ?? {}),
    });
  }
  const usage = asObject(response.usage) as OpenAiUsage;
  const status = choice.finish_reason === "length" ? "incomplete" : "completed";
  return responseEnvelope({
    id:
      stringValue(response.id)
        ?.replace(/^chatcmpl_/, "resp_")
        .replace(/^msg_/, "resp_") ??
      `resp_${randomBytes(12).toString("hex")}`,
    model: stringValue(response.model) ?? stringValue(request.model) ?? "unknown",
    output,
    request,
    status,
    usage,
    ...(status === "incomplete"
      ? { incompleteDetails: { reason: "max_output_tokens" } }
      : {}),
  });
}

export function anthropicRequestToOpenAi(input: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  const system = anthropicText(input.system);
  if (system) messages.push({ role: "system", content: system });
  for (const value of arrayValue(input.messages)) {
    const message = asObject(value);
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    const blocks = arrayValue(content);
    if (role === "assistant") {
      const textBlocks: JsonObject[] = [];
      const toolCalls: JsonObject[] = [];
      for (const blockValue of blocks) {
        const block = asObject(blockValue);
        if (block.type === "text" && typeof block.text === "string") {
          textBlocks.push({ type: "text", text: block.text });
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      messages.push({
        role,
        content: openAiContent(textBlocks),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const userBlocks: JsonObject[] = [];
    const toolMessages: JsonObject[] = [];
    for (const blockValue of blocks) {
      const block = asObject(blockValue);
      if (block.type === "text" && typeof block.text === "string") {
        userBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const imageUrl = anthropicImageUrl(asObject(block.source));
        if (imageUrl) {
          userBlocks.push({
            type: "image_url",
            image_url: { url: imageUrl },
          });
        }
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: anthropicText(block.content),
        });
      }
    }
    if (userBlocks.length > 0) {
      messages.push({ role: "user", content: openAiContent(userBlocks) });
    }
    messages.push(...toolMessages);
  }

  return compactObject({
    model: input.model,
    messages,
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    top_p: input.top_p,
    stop: input.stop_sequences,
    stream: input.stream,
    tools: arrayValue(input.tools).map((toolValue) => {
      const tool = asObject(toolValue);
      return {
        type: "function",
        function: compactObject({
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        }),
      };
    }),
    tool_choice: anthropicToolChoice(input.tool_choice),
  });
}

export function openAiRequestToAnthropic(input: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  const systemParts: string[] = [];
  for (const value of arrayValue(input.messages)) {
    const message = asObject(value);
    if (message.role === "system" || message.role === "developer") {
      const text = openAiText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id === "string") {
        appendAnthropicMessage(messages, "user", [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: openAiText(message.content),
        }]);
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks = openAiContentToAnthropic(message.content);
    if (role === "assistant") {
      for (const toolCallValue of arrayValue(message.tool_calls)) {
        const toolCall = asObject(toolCallValue);
        const function_ = asObject(toolCall.function);
        if (
          typeof toolCall.id === "string" &&
          typeof function_.name === "string"
        ) {
          blocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: function_.name,
            input: parseToolArguments(function_.arguments),
          });
        }
      }
    }
    appendAnthropicMessage(messages, role, blocks);
  }

  return compactObject({
    model: input.model,
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4_096,
    temperature: input.temperature,
    top_p: input.top_p,
    stop_sequences:
      typeof input.stop === "string"
        ? [input.stop]
        : Array.isArray(input.stop)
          ? input.stop
          : undefined,
    stream: input.stream,
    tools: arrayValue(input.tools).flatMap((toolValue) => {
      const tool = asObject(toolValue);
      const function_ = asObject(tool.function);
      return typeof function_.name === "string"
        ? [{
            name: function_.name,
            ...(typeof function_.description === "string"
              ? { description: function_.description }
              : {}),
            input_schema:
              isObject(function_.parameters)
                ? function_.parameters
                : { type: "object", properties: {} },
          }]
        : [];
    }),
    tool_choice: openAiToolChoice(input.tool_choice),
  });
}

export function openAiResponseToAnthropic(
  response: JsonObject,
  request: JsonObject,
): JsonObject {
  const choice = asObject(arrayValue(response.choices)[0]);
  const message = asObject(choice.message);
  const content = openAiContentToAnthropic(message.content);
  for (const toolCallValue of arrayValue(message.tool_calls)) {
    const toolCall = asObject(toolCallValue);
    const function_ = asObject(toolCall.function);
    if (typeof function_.name !== "string") continue;
    content.push({
      type: "tool_use",
      id:
        typeof toolCall.id === "string"
          ? toolCall.id
          : `toolu_${randomBytes(12).toString("hex")}`,
      name: function_.name,
      input: parseToolArguments(function_.arguments),
    });
  }
  const usage = asObject(response.usage) as OpenAiUsage;
  return {
    id:
      typeof response.id === "string"
        ? response.id
        : `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: response.model ?? request.model ?? "unknown",
    content,
    stop_reason: openAiFinishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsageFromOpenAi(usage),
  };
}

export function anthropicResponseToOpenAi(
  response: JsonObject,
  request: JsonObject,
): JsonObject {
  const text: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const blockValue of arrayValue(response.content)) {
    const block = asObject(blockValue);
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const usage = asObject(response.usage);
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  return {
    id:
      typeof response.id === "string"
        ? response.id
        : `chatcmpl_${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: response.model ?? request.model ?? "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text.length > 0 ? text.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: anthropicStopReasonToOpenAi(response.stop_reason),
      logprobs: null,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(numberValue(usage.cache_read_input_tokens) > 0
        ? {
            prompt_tokens_details: {
              cached_tokens: numberValue(usage.cache_read_input_tokens),
            },
          }
        : {}),
    },
  };
}

async function* responsesStreamToOpenAi(
  body: ReadableStream<Uint8Array>,
  request: JsonObject,
): AsyncGenerator<string> {
  let id = `chatcmpl_${randomBytes(12).toString("hex")}`;
  let model = stringValue(request.model) ?? "unknown";
  const created = Math.floor(Date.now() / 1_000);
  let sentRole = false;
  let finished = false;
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 0;
  const chunk = (
    delta: JsonObject,
    finishReason: unknown = null,
    usage?: JsonObject,
  ) => openAiSse(compactObject({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      logprobs: null,
    }],
    usage,
  }));
  const role = (): string[] => {
    if (sentRole) return [];
    sentRole = true;
    return [chunk({ role: "assistant", content: "" })];
  };

  for await (const event of readSse(body)) {
    if (event.data === "[DONE]") break;
    let payload: JsonObject;
    try {
      payload = asObject(JSON.parse(event.data));
    } catch {
      continue;
    }
    const type = stringValue(payload.type) ?? event.event;
    const response = asObject(payload.response);
    if (typeof response.id === "string") {
      id = response.id.replace(/^resp_/, "chatcmpl_");
    }
    if (typeof response.model === "string") model = response.model;
    if (type === "response.output_item.added") {
      const item = asObject(payload.item);
      if (item.type === "function_call") {
        for (const output of role()) yield output;
        const outputIndex = numberValue(payload.output_index);
        const toolIndex = nextToolIndex++;
        toolIndexes.set(outputIndex, toolIndex);
        yield chunk({
          tool_calls: [{
            index: toolIndex,
            id:
              stringValue(item.call_id) ??
              stringValue(item.id) ??
              `call_${randomBytes(12).toString("hex")}`,
            type: "function",
            function: {
              name: stringValue(item.name) ?? "tool",
              arguments: "",
            },
          }],
        });
      }
    } else if (type === "response.output_text.delta") {
      for (const output of role()) yield output;
      if (typeof payload.delta === "string") {
        yield chunk({ content: payload.delta });
      }
    } else if (type === "response.function_call_arguments.delta") {
      for (const output of role()) yield output;
      const toolIndex = toolIndexes.get(numberValue(payload.output_index));
      if (toolIndex !== undefined && typeof payload.delta === "string") {
        yield chunk({
          tool_calls: [{
            index: toolIndex,
            function: { arguments: payload.delta },
          }],
        });
      }
    } else if (
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      for (const output of role()) yield output;
      const usage = asObject(response.usage);
      const inputTokens = numberValue(usage.input_tokens);
      const outputTokens = numberValue(usage.output_tokens);
      yield chunk(
        {},
        toolIndexes.size > 0
          ? "tool_calls"
          : type === "response.incomplete"
            ? "length"
            : "stop",
        {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens:
            numberValue(usage.total_tokens) || inputTokens + outputTokens,
          prompt_tokens_details: {
            cached_tokens: numberValue(
              asObject(usage.input_tokens_details).cached_tokens,
            ),
          },
          completion_tokens_details: {
            reasoning_tokens: numberValue(
              asObject(usage.output_tokens_details).reasoning_tokens,
            ),
          },
        },
      );
      yield "data: [DONE]\n\n";
      finished = true;
      break;
    }
  }
  if (!finished) {
    for (const output of role()) yield output;
    yield chunk({}, toolIndexes.size > 0 ? "tool_calls" : "stop");
    yield "data: [DONE]\n\n";
  }
}

async function* openAiStreamToResponses(
  body: ReadableStream<Uint8Array>,
  request: JsonObject,
): AsyncGenerator<string> {
  let id = `resp_${randomBytes(12).toString("hex")}`;
  let model = stringValue(request.model) ?? "unknown";
  let sequence = 0;
  let started = false;
  let finishReason: unknown;
  let usage: OpenAiUsage = {};
  let textItem:
    | { id: string; index: number; text: string; open: boolean }
    | undefined;
  const tools = new Map<number, {
    arguments: string;
    callId: string;
    id: string;
    index: number;
    name: string;
    open: boolean;
  }>();
  let nextOutputIndex = 0;

  const event = (type: string, payload: JsonObject): string =>
    responsesSse(type, {
      type,
      sequence_number: sequence++,
      ...payload,
    });
  const start = (): string[] => {
    if (started) return [];
    started = true;
    const response = responseEnvelope({
      id,
      model,
      output: [],
      request,
      status: "in_progress",
      usage: {},
    });
    return [
      event("response.created", { response }),
      event("response.in_progress", { response }),
    ];
  };

  for await (const sse of readSse(body)) {
    if (sse.data === "[DONE]") break;
    let chatChunk: JsonObject;
    try {
      chatChunk = asObject(JSON.parse(sse.data));
    } catch {
      continue;
    }
    if (typeof chatChunk.id === "string") {
      id = chatChunk.id
        .replace(/^chatcmpl_/, "resp_")
        .replace(/^msg_/, "resp_");
    }
    if (typeof chatChunk.model === "string") model = chatChunk.model;
    if (isObject(chatChunk.usage)) usage = chatChunk.usage as OpenAiUsage;
    const choice = asObject(arrayValue(chatChunk.choices)[0]);
    const delta = asObject(choice.delta);
    for (const output of start()) yield output;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textItem) {
        const createdTextItem = {
          id: `msg_${randomBytes(12).toString("hex")}`,
          index: nextOutputIndex++,
          text: "",
          open: true,
        };
        textItem = createdTextItem;
        yield event("response.output_item.added", {
          output_index: createdTextItem.index,
          item: {
            id: createdTextItem.id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        yield event("response.content_part.added", {
          item_id: createdTextItem.id,
          output_index: createdTextItem.index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [], logprobs: [] },
        });
      }
      textItem.text += delta.content;
      yield event("response.output_text.delta", {
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    }

    for (const toolValue of arrayValue(delta.tool_calls)) {
      const toolDelta = asObject(toolValue);
      const upstreamIndex = numberValue(toolDelta.index);
      const function_ = asObject(toolDelta.function);
      let tool = tools.get(upstreamIndex);
      if (!tool) {
        const callId =
          stringValue(toolDelta.id) ??
          `call_${randomBytes(12).toString("hex")}`;
        tool = {
          arguments: "",
          callId,
          id: callId.replace(/^call_/, "fc_"),
          index: nextOutputIndex++,
          name: stringValue(function_.name) ?? "tool",
          open: true,
        };
        tools.set(upstreamIndex, tool);
        yield event("response.output_item.added", {
          output_index: tool.index,
          item: {
            id: tool.id,
            type: "function_call",
            status: "in_progress",
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
          },
        });
      }
      if (typeof function_.name === "string") tool.name = function_.name;
      if (typeof function_.arguments === "string" && function_.arguments) {
        tool.arguments += function_.arguments;
        yield event("response.function_call_arguments.delta", {
          item_id: tool.id,
          output_index: tool.index,
          delta: function_.arguments,
        });
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }
  }

  for (const output of start()) yield output;
  const output: JsonObject[] = [];
  if (textItem) {
    yield event("response.output_text.done", {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      text: textItem.text,
      logprobs: [],
    });
    const part = {
      type: "output_text",
      text: textItem.text,
      annotations: [],
      logprobs: [],
    };
    yield event("response.content_part.done", {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part,
    });
    const item = {
      id: textItem.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    output.push(item);
    yield event("response.output_item.done", {
      output_index: textItem.index,
      item,
    });
  }
  for (const tool of [...tools.values()].sort((left, right) => left.index - right.index)) {
    yield event("response.function_call_arguments.done", {
      item_id: tool.id,
      output_index: tool.index,
      arguments: tool.arguments,
    });
    const item = {
      id: tool.id,
      type: "function_call",
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
    };
    output.push(item);
    yield event("response.output_item.done", {
      output_index: tool.index,
      item,
    });
  }
  output.sort((left, right) => {
    const leftIndex = left.id === textItem?.id
      ? (textItem?.index ?? 0)
      : [...tools.values()].find((tool) => tool.id === left.id)?.index ?? 0;
    const rightIndex = right.id === textItem?.id
      ? (textItem?.index ?? 0)
      : [...tools.values()].find((tool) => tool.id === right.id)?.index ?? 0;
    return leftIndex - rightIndex;
  });
  const status = finishReason === "length" ? "incomplete" : "completed";
  const response = responseEnvelope({
    id,
    model,
    output,
    request,
    status,
    usage,
    ...(status === "incomplete"
      ? { incompleteDetails: { reason: "max_output_tokens" } }
      : {}),
  });
  yield event(
    status === "completed" ? "response.completed" : "response.incomplete",
    { response },
  );
}

async function* openAiStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
  request: JsonObject,
): AsyncGenerator<string> {
  let id = `msg_${randomBytes(12).toString("hex")}`;
  let model = typeof request.model === "string" ? request.model : "unknown";
  let started = false;
  let textIndex: number | undefined;
  let nextBlockIndex = 0;
  let finishReason: unknown;
  let usage: OpenAiUsage = {};
  const toolIndexes = new Map<number, number>();
  const openBlocks = new Set<number>();

  const start = (): string[] => {
    if (started) return [];
    started = true;
    return [anthropicSse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: numberValue(usage.prompt_tokens), output_tokens: 0 },
      },
    })];
  };

  for await (const event of readSse(body)) {
    if (event.data === "[DONE]") break;
    let chunk: JsonObject;
    try {
      chunk = asObject(JSON.parse(event.data));
    } catch {
      continue;
    }
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.model === "string") model = chunk.model;
    if (isObject(chunk.usage)) usage = chunk.usage as OpenAiUsage;
    const choice = asObject(arrayValue(chunk.choices)[0]);
    const delta = asObject(choice.delta);
    for (const output of start()) yield output;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (textIndex === undefined) {
        textIndex = nextBlockIndex++;
        openBlocks.add(textIndex);
        yield anthropicSse("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      yield anthropicSse("content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    for (const toolValue of arrayValue(delta.tool_calls)) {
      const tool = asObject(toolValue);
      const upstreamIndex = numberValue(tool.index);
      let blockIndex = toolIndexes.get(upstreamIndex);
      const function_ = asObject(tool.function);
      if (blockIndex === undefined) {
        blockIndex = nextBlockIndex++;
        toolIndexes.set(upstreamIndex, blockIndex);
        openBlocks.add(blockIndex);
        yield anthropicSse("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id:
              typeof tool.id === "string"
                ? tool.id
                : `toolu_${randomBytes(12).toString("hex")}`,
            name:
              typeof function_.name === "string" ? function_.name : "tool",
            input: {},
          },
        });
      }
      if (typeof function_.arguments === "string" && function_.arguments) {
        yield anthropicSse("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: function_.arguments,
          },
        });
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }
  }
  for (const output of start()) yield output;
  for (const index of [...openBlocks].sort((left, right) => left - right)) {
    yield anthropicSse("content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }
  yield anthropicSse("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: openAiFinishReasonToAnthropic(finishReason),
      stop_sequence: null,
    },
    usage: { output_tokens: numberValue(usage.completion_tokens) },
  });
  yield anthropicSse("message_stop", { type: "message_stop" });
}

async function* anthropicStreamToOpenAi(
  body: ReadableStream<Uint8Array>,
  request: JsonObject,
): AsyncGenerator<string> {
  let id = `chatcmpl_${randomBytes(12).toString("hex")}`;
  let model = typeof request.model === "string" ? request.model : "unknown";
  let created = Math.floor(Date.now() / 1_000);
  let sentRole = false;
  let finishReason: unknown;
  let promptTokens = 0;
  let completionTokens = 0;
  const tools = new Map<number, number>();
  let nextToolIndex = 0;

  const chunk = (delta: JsonObject, finish: unknown = null, usage?: JsonObject) =>
    openAiSse(compactObject({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      usage,
    }));

  for await (const event of readSse(body)) {
    let payload: JsonObject;
    try {
      payload = asObject(JSON.parse(event.data));
    } catch {
      continue;
    }
    const type = typeof payload.type === "string" ? payload.type : event.event;
    if (type === "message_start") {
      const message = asObject(payload.message);
      if (typeof message.id === "string") id = message.id;
      if (typeof message.model === "string") model = message.model;
      created = Math.floor(Date.now() / 1_000);
      promptTokens = numberValue(asObject(message.usage).input_tokens);
      if (!sentRole) {
        sentRole = true;
        yield chunk({ role: "assistant", content: "" });
      }
    } else if (type === "content_block_start") {
      const block = asObject(payload.content_block);
      if (block.type === "tool_use") {
        const blockIndex = numberValue(payload.index);
        const toolIndex = nextToolIndex++;
        tools.set(blockIndex, toolIndex);
        yield chunk({
          tool_calls: [{
            index: toolIndex,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        });
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        yield chunk({ content: block.text });
      }
    } else if (type === "content_block_delta") {
      const delta = asObject(payload.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield chunk({ content: delta.text });
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const toolIndex = tools.get(numberValue(payload.index));
        if (toolIndex !== undefined) {
          yield chunk({
            tool_calls: [{
              index: toolIndex,
              function: { arguments: delta.partial_json },
            }],
          });
        }
      }
    } else if (type === "message_delta") {
      const delta = asObject(payload.delta);
      finishReason = delta.stop_reason;
      completionTokens = numberValue(asObject(payload.usage).output_tokens);
    }
  }
  if (!sentRole) yield chunk({ role: "assistant", content: "" });
  yield chunk(
    {},
    anthropicStopReasonToOpenAi(finishReason),
    {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  );
  yield "data: [DONE]\n\n";
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
      if (done) break;
    }
    const event = parseSseFrame(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length > 0 ? { data: data.join("\n"), ...(event ? { event } : {}) } : undefined;
}

function anthropicSse(event: string, payload: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function openAiSse(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function responsesSse(event: string, payload: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function textIterableToStream(
  iterable: AsyncIterable<string>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(next.value));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function mapUpstreamError(
  upstream: Response,
  reply: FastifyReply,
  incomingProtocol: GatewayProtocol,
  providerSecret?: string,
): Promise<unknown> {
  const text = (await upstream.text()).slice(0, MAX_ERROR_BODY_BYTES);
  let payload: JsonObject = {};
  try {
    payload = asObject(JSON.parse(text));
  } catch {
    // A provider can return an HTML proxy error; only its status is exposed.
  }
  const nested = asObject(payload.error);
  const rawMessage =
    stringValue(nested.message) ??
    stringValue(payload.message) ??
    `The model provider returned HTTP ${upstream.status}.`;
  const message = providerSecret
    ? rawMessage.split(providerSecret).join("[redacted]")
    : rawMessage;
  const code =
    stringValue(nested.code) ??
    stringValue(nested.type) ??
    `upstream_${upstream.status}`;
  return gatewayError(reply, incomingProtocol, upstream.status, code, message);
}

function gatewayError(
  reply: FastifyReply,
  protocol: GatewayProtocol,
  status: number,
  code: string,
  message: string,
): unknown {
  reply.header("cache-control", "no-store").code(status);
  if (protocol === "anthropic") {
    return reply.send({
      type: "error",
      error: {
        type: anthropicErrorType(status, code),
        message,
      },
    });
  }
  return reply.send({
    error: {
      message,
      type: openAiErrorType(status),
      param: null,
      code,
    },
  });
}

function anthropicErrorType(status: number, code: string): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (code.includes("overloaded") || status === 529) return "overloaded_error";
  return "api_error";
}

function openAiErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  return status >= 500 ? "server_error" : "invalid_request_error";
}

function upstreamHeaders(
  source: ResolvedModelGatewaySource["source"],
  upstreamProtocol: GatewayProtocol,
  apiKey: string | undefined,
  incomingHeaders: FastifyRequest["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (upstreamProtocol === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] =
      headerValue(incomingHeaders["anthropic-version"]) ??
      DEFAULT_ANTHROPIC_VERSION;
    const beta = headerValue(incomingHeaders["anthropic-beta"]);
    if (beta) headers["anthropic-beta"] = beta;
  } else if (source.protocol === "azure-openai") {
    if (apiKey) headers["api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function copyResponseHeaders(upstream: Response, reply: FastifyReply): void {
  for (const header of [
    "retry-after",
    "x-request-id",
    "request-id",
    "anthropic-request-id",
  ]) {
    const value = upstream.headers.get(header);
    if (value) reply.header(header, value);
  }
}

function protocolForSource(
  source: ResolvedModelGatewaySource["source"],
): GatewayProtocol {
  if (source.apiFormat === "anthropic-messages") return "anthropic";
  if (source.apiFormat === "openai-chat-completions") return "openai-chat";
  if (source.apiFormat === "openai-responses") return "openai-responses";
  if (source.protocol === "anthropic") return "anthropic";
  if (source.kind === "official-api" && source.protocol === "openai") {
    return "openai-responses";
  }
  if (
    source.protocol === "ollama" ||
    source.protocol === "azure-openai"
  ) {
    return "openai-chat";
  }
  if (source.protocol === "openai") {
    return "openai-chat";
  }
  return "openai-chat";
}

function upstreamEndpoint(
  source: ResolvedModelGatewaySource["source"],
  protocol: GatewayProtocol,
): string | undefined {
  const defaultEndpoint =
    source.kind === "official-api"
      ? protocol === "anthropic"
        ? "https://api.anthropic.com"
        : "https://api.openai.com/v1"
      : undefined;
  const endpoint = source.endpoint ?? defaultEndpoint;
  if (!endpoint) return undefined;
  const suffix = protocol === "anthropic"
    ? "v1/messages"
    : protocol === "openai-responses"
      ? "responses"
      : "chat/completions";
  const parsed = new URL(endpoint);
  const query = parsed.search;
  parsed.search = "";
  const normalized = parsed.toString().replace(/\/+$/, "");
  if (normalized.endsWith(`/${suffix}`)) return `${normalized}${query}`;
  if (suffix.startsWith("v1/") && normalized.endsWith("/v1")) {
    return `${normalized}/${suffix.slice(3)}${query}`;
  }
  if (
    source.protocol === "ollama" &&
    protocol === "openai-chat" &&
    !normalized.endsWith("/v1")
  ) {
    return `${normalized}/v1/chat/completions${query}`;
  }
  return `${normalized}/${suffix}${query}`;
}

function requiresCredential(
  source: ResolvedModelGatewaySource["source"],
): boolean {
  return source.kind !== "official-account" && source.kind !== "local-service";
}

function readSourceId(params: unknown): string {
  const value = asObject(params).sourceId;
  return requiredSourceId(value);
}

function readGatewayToken(
  headers: FastifyRequest["headers"],
): string | undefined {
  const authorization = headerValue(headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return headerValue(headers["x-api-key"]);
}

function loadOrCreateTokenKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.byteLength < 32) {
    throw new Error("Model Gateway token key is invalid.");
  }
  return key;
}

function requiredClaim(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Model Gateway ${name} is invalid.`);
  }
  return value;
}

function requiredSourceId(value: unknown): string {
  const sourceId = requiredClaim(value, "sourceId", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sourceId)) {
    throw new Error("Model Gateway sourceId is invalid.");
  }
  return sourceId;
}

function anthropicText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .flatMap((entry) => {
      const block = asObject(entry);
      if (block.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    })
    .join("");
}

function openAiText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .flatMap((entry) => {
      const part = asObject(entry);
      if (
        (part.type === "text" || part.type === "input_text") &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("");
}

function openAiContentToAnthropic(value: unknown): JsonObject[] {
  if (typeof value === "string") {
    return value ? [{ type: "text", text: value }] : [];
  }
  const blocks: JsonObject[] = [];
  for (const entry of arrayValue(value)) {
    const part = asObject(entry);
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const imageUrl =
        typeof part.image_url === "string"
          ? part.image_url
          : stringValue(asObject(part.image_url).url);
      if (!imageUrl) continue;
      if (imageUrl.startsWith("data:")) {
        const match = /^data:([^;,]+);base64,(.+)$/.exec(imageUrl);
        if (match) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: match[1],
              data: match[2],
            },
          });
        }
        continue;
      }
      blocks.push({ type: "image", source: { type: "url", url: imageUrl } });
    }
  }
  return blocks;
}

function anthropicImageUrl(source: JsonObject): string | undefined {
  if (source.type === "url" && typeof source.url === "string") {
    return source.url;
  }
  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

function openAiContent(blocks: JsonObject[]): string | JsonObject[] | null {
  if (blocks.length === 0) return null;
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => stringValue(block.text) ?? "").join("");
  }
  return blocks;
}

function responsesContentToOpenAi(value: unknown): string | JsonObject[] | null {
  if (typeof value === "string") return value;
  const parts: JsonObject[] = [];
  for (const partValue of arrayValue(value)) {
    const part = asObject(partValue);
    if (
      (part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url,
          ...(typeof part.detail === "string" ? { detail: part.detail } : {}),
        },
      });
    }
  }
  return openAiContent(parts);
}

function openAiContentToResponses(
  value: unknown,
  role: "assistant" | "user",
): JsonObject[] {
  if (typeof value === "string") {
    return value
      ? [{ type: role === "assistant" ? "output_text" : "input_text", text: value }]
      : [];
  }
  const parts: JsonObject[] = [];
  for (const partValue of arrayValue(value)) {
    const part = asObject(partValue);
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      parts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      });
    } else if (role === "user" && part.type === "image_url") {
      const imageUrl =
        typeof part.image_url === "string"
          ? part.image_url
          : stringValue(asObject(part.image_url).url);
      if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
    }
  }
  return parts;
}

function openAiToolChoiceToResponses(value: unknown): unknown {
  if (value === "auto" || value === "required" || value === "none") {
    return value;
  }
  const choice = asObject(value);
  const function_ = asObject(choice.function);
  if (choice.type === "function" && typeof function_.name === "string") {
    return { type: "function", name: function_.name };
  }
  return undefined;
}

function openAiResponseFormatToResponses(value: unknown): unknown {
  const format = asObject(value);
  if (format.type === "json_schema" || format.type === "json_object") {
    return { format };
  }
  return undefined;
}

function responsesToolChoiceToOpenAi(value: unknown): unknown {
  if (value === "auto" || value === "required" || value === "none") {
    return value;
  }
  const choice = asObject(value);
  if (choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function responsesTextFormat(value: unknown): unknown {
  const text = asObject(value);
  const format = asObject(text.format);
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: compactObject({
        name: format.name,
        description: format.description,
        schema: format.schema,
        strict: format.strict,
      }),
    };
  }
  if (format.type === "json_object") return { type: "json_object" };
  return undefined;
}

function responseEnvelope(input: {
  id: string;
  incompleteDetails?: JsonObject;
  model: string;
  output: JsonObject[];
  request: JsonObject;
  status: string;
  usage: OpenAiUsage;
}): JsonObject {
  const inputTokens = numberValue(input.usage.prompt_tokens);
  const outputTokens = numberValue(input.usage.completion_tokens);
  return {
    id: input.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status: input.status,
    background: false,
    error: null,
    incomplete_details: input.incompleteDetails ?? null,
    instructions: input.request.instructions ?? null,
    max_output_tokens: input.request.max_output_tokens ?? null,
    max_tool_calls: input.request.max_tool_calls ?? null,
    model: input.model,
    output: input.output,
    parallel_tool_calls: input.request.parallel_tool_calls ?? true,
    previous_response_id: input.request.previous_response_id ?? null,
    prompt: input.request.prompt ?? null,
    reasoning: input.request.reasoning ?? { effort: null, summary: null },
    safety_identifier: input.request.safety_identifier ?? null,
    service_tier: input.request.service_tier ?? "default",
    store: input.request.store ?? false,
    temperature: input.request.temperature ?? null,
    text: input.request.text ?? { format: { type: "text" }, verbosity: "medium" },
    tool_choice: input.request.tool_choice ?? "auto",
    tools: input.request.tools ?? [],
    top_logprobs: input.request.top_logprobs ?? 0,
    top_p: input.request.top_p ?? null,
    truncation: input.request.truncation ?? "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: {
        cached_tokens: numberValue(
          input.usage.prompt_tokens_details?.cached_tokens,
        ),
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: numberValue(
          input.usage.completion_tokens_details?.reasoning_tokens,
        ),
      },
      total_tokens:
        numberValue(input.usage.total_tokens) || inputTokens + outputTokens,
    },
    user: input.request.user ?? null,
    metadata: input.request.metadata ?? {},
  };
}

function appendAnthropicMessage(
  messages: JsonObject[],
  role: "assistant" | "user",
  blocks: JsonObject[],
): void {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function anthropicToolChoice(value: unknown): unknown {
  const choice = asObject(value);
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function openAiToolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none") return { type: value };
  if (value === "required") return { type: "any" };
  const choice = asObject(value);
  const function_ = asObject(choice.function);
  if (choice.type === "function" && typeof function_.name === "string") {
    return { type: "tool", name: function_.name };
  }
  return undefined;
}

function parseToolArguments(value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: value };
  }
}

function anthropicUsageFromOpenAi(usage: OpenAiUsage): JsonObject {
  return compactObject({
    input_tokens: numberValue(usage.prompt_tokens),
    output_tokens: numberValue(usage.completion_tokens),
    cache_read_input_tokens: numberValue(
      usage.prompt_tokens_details?.cached_tokens,
    ) || undefined,
  });
}

function openAiFinishReasonToAnthropic(value: unknown): string | null {
  if (value === "length") return "max_tokens";
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "stop") return "end_turn";
  if (value === "content_filter") return "stop_sequence";
  return value === null || value === undefined ? null : "end_turn";
}

function anthropicStopReasonToOpenAi(value: unknown): string | null {
  if (value === "max_tokens") return "length";
  if (value === "tool_use") return "tool_calls";
  if (value === "end_turn" || value === "stop_sequence") return "stop";
  return value === null || value === undefined ? null : "stop";
}

function compactObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
