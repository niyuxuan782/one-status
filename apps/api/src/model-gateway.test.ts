import Fastify, { type FastifyInstance } from "fastify";
import type {
  ModelApiFormat,
  ModelApiProtocol,
  ModelSourceKind,
} from "@one-status/protocol";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelGateway,
  ModelGatewayTokenAuthority,
  registerModelGatewayRoutes,
} from "./model-gateway.js";

describe("Model Gateway", () => {
  const apps: FastifyInstance[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("issues stable source-bound tokens and rejects a modified token", async () => {
    const fixture = createFixture(apps, "openai", vi.fn<typeof fetch>());
    const first = fixture.gateway.configuration({
      sourceId: "source-1",
      targetProtocol: "anthropic",
      userId: "user-1",
    });
    const second = fixture.gateway.configuration({
      sourceId: "source-1",
      targetProtocol: "anthropic",
      userId: "user-1",
    });

    expect(first).toEqual(second);
    expect(first.endpoint).toBe(
      "http://127.0.0.1:8787/v1/model-gateway/source-1",
    );
    expect(first.token).toMatch(/^osmg_v1\./);

    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/model-gateway/source-1/v1/messages",
      headers: { authorization: `Bearer ${first.token.slice(0, -1)}x` },
      payload: { model: "gpt-test", max_tokens: 10, messages: [] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "The Model Gateway credential is invalid.",
      },
    });
  });

  it("keeps proxy tokens valid across token-authority restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "one-status-gateway-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "gateway.key");
    const first = new ModelGatewayTokenAuthority({ keyPath });
    const token = first.issue({ sourceId: "source-1", userId: "user-1" });
    const second = new ModelGatewayTokenAuthority({ keyPath });

    expect(second.issue({ sourceId: "source-1", userId: "user-1" })).toBe(token);
    expect(second.verify(token)).toEqual({
      sourceId: "source-1",
      userId: "user-1",
      version: 1,
    });
    if (process.platform !== "win32") {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });

  it("converts Anthropic Messages to OpenAI Chat Completions without exposing the provider key", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://openai-compatible.test/v1/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer provider-secret-key",
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-test",
        max_tokens: 256,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is pending?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "toolu_1",
              type: "function",
              function: {
                name: "project_get",
                arguments: "{\"id\":\"one-status\"}",
              },
            }],
          },
          { role: "tool", tool_call_id: "toolu_1", content: "Gateway" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "project_get",
            description: "Read a project",
            parameters: { type: "object", properties: {} },
          },
        }],
      });
      return json({
        id: "chatcmpl_1",
        model: "gpt-test-2026-08-10",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "I will check.",
            tool_calls: [{
              id: "call_2",
              type: "function",
              function: { name: "project_get", arguments: "{\"id\":\"os\"}" },
            }],
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      });
    });
    const fixture = createFixture(apps, "openai", fetch_);
    const response = await injectAuthorized(fixture, "messages", {
      model: "gpt-test",
      max_tokens: 256,
      system: [{ type: "text", text: "Be concise." }],
      messages: [
        { role: "user", content: "What is pending?" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "project_get",
            input: { id: "one-status" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Gateway",
          }],
        },
      ],
      tools: [{
        name: "project_get",
        description: "Read a project",
        input_schema: { type: "object", properties: {} },
      }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "chatcmpl_1",
      type: "message",
      role: "assistant",
      model: "gpt-test-2026-08-10",
      content: [
        { type: "text", text: "I will check." },
        {
          type: "tool_use",
          id: "call_2",
          name: "project_get",
          input: { id: "os" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 4,
      },
    });
    expect(response.body).not.toContain("provider-secret-key");
  });

  it("converts OpenAI Chat Completions to Anthropic Messages with tool results and usage", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://anthropic.test/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("provider-secret-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "claude-test",
        max_tokens: 512,
        system: "Follow project rules.",
        messages: [
          { role: "user", content: [{ type: "text", text: "Continue." }] },
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "call_1",
              name: "status_get",
              input: { scope: "project" },
            }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call_1",
              content: "ready",
            }],
          },
        ],
      });
      return json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test-20260810",
        content: [
          { type: "text", text: "Next step." },
          { type: "tool_use", id: "toolu_9", name: "status_get", input: { scope: "user" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 3 },
      });
    });
    const fixture = createFixture(apps, "anthropic", fetch_);
    const response = await injectAuthorized(fixture, "chat/completions", {
      model: "claude-test",
      max_tokens: 512,
      messages: [
        { role: "developer", content: "Follow project rules." },
        { role: "user", content: "Continue." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "status_get", arguments: "{\"scope\":\"project\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ready" },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "msg_1",
      object: "chat.completion",
      model: "claude-test-20260810",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Next step.",
          tool_calls: [{
            id: "toolu_9",
            type: "function",
            function: { name: "status_get", arguments: "{\"scope\":\"user\"}" },
          }],
        },
      }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 5,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
  });

  it("streams OpenAI text and tool calls as Anthropic SSE", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      return sse([
        'data: {"id":"chat_1","model":"gpt-test","choices":[{"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","model":"gpt-test","choices":[{"delta":{"content":"Ryan","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"status_get","arguments":"{\\"scope\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","model":"gpt-test","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"user\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    const fixture = createFixture(apps, "openai", fetch_);
    const response = await injectAuthorized(fixture, "messages", {
      model: "gpt-test",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('"type":"text_delta","text":"Hello "');
    expect(response.body).toContain('"type":"text_delta","text":"Ryan"');
    expect(response.body).toContain('"type":"tool_use","id":"call_1","name":"status_get"');
    expect(response.body).toContain('"type":"input_json_delta","partial_json":"{\\"scope\\":"');
    expect(response.body).toContain('"stop_reason":"tool_use"');
    expect(response.body).toContain('"output_tokens":4');
    expect(response.body).toContain('event: message_stop');
  });

  it("streams Anthropic text and tool calls as OpenAI SSE", async () => {
    const fetch_ = vi.fn<typeof fetch>(async () =>
      sse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":6}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Working"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"status_get","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"scope\\":\\"project\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const fixture = createFixture(apps, "anthropic", fetch_);
    const response = await injectAuthorized(fixture, "chat/completions", {
      model: "claude-test",
      stream: true,
      messages: [{ role: "user", content: "Continue" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":{"role":"assistant","content":""}');
    expect(response.body).toContain('"delta":{"content":"Working"}');
    expect(response.body).toContain('"id":"toolu_1","type":"function","function":{"name":"status_get","arguments":""}');
    expect(response.body).toContain('"function":{"arguments":"{\\"scope\\":\\"project\\"}"}');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
    expect(response.body).toContain('"prompt_tokens":6,"completion_tokens":3,"total_tokens":9');
    expect(response.body).toMatch(/data: \[DONE\]\n\n$/);
  });

  it("converts OpenAI Responses requests and completed responses through Chat Completions", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-compatible",
        max_tokens: 900,
        messages: [
          { role: "system", content: "Use One Status context." },
          { role: "user", content: "Continue the project." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_previous",
              type: "function",
              function: { name: "status_get", arguments: "{\"scope\":\"project\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call_previous", content: "ready" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "status_get",
            description: "Read status",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        }],
      });
      return json({
        id: "chatcmpl_response_1",
        model: "gpt-compatible-2026",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking status.",
            tool_calls: [{
              id: "call_next",
              type: "function",
              function: { name: "status_get", arguments: "{\"scope\":\"user\"}" },
            }],
          },
        }],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 8,
          total_tokens: 29,
          prompt_tokens_details: { cached_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      });
    });
    const fixture = createFixture(apps, "openai", fetch_);
    const response = await injectAuthorized(fixture, "responses", {
      model: "gpt-compatible",
      instructions: "Use One Status context.",
      max_output_tokens: 900,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue the project." }],
        },
        {
          type: "function_call",
          call_id: "call_previous",
          name: "status_get",
          arguments: "{\"scope\":\"project\"}",
        },
        { type: "function_call_output", call_id: "call_previous", output: "ready" },
      ],
      tools: [{
        type: "function",
        name: "status_get",
        description: "Read status",
        parameters: { type: "object", properties: {} },
        strict: true,
      }],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: "resp_response_1",
      object: "response",
      status: "completed",
      model: "gpt-compatible-2026",
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking status." }],
        },
        {
          type: "function_call",
          status: "completed",
          call_id: "call_next",
          name: "status_get",
          arguments: "{\"scope\":\"user\"}",
        },
      ],
      usage: {
        input_tokens: 21,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 29,
      },
    });
  });

  it("streams Chat Completions as native OpenAI Responses events", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      return sse([
        'data: {"id":"chatcmpl_stream_1","model":"gpt-compatible","choices":[{"delta":{"role":"assistant","content":"Done"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_stream_1","model":"gpt-compatible","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"status_get","arguments":"{\\"scope\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_stream_1","model":"gpt-compatible","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"project\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    const fixture = createFixture(apps, "openai", fetch_);
    const response = await injectAuthorized(fixture, "responses", {
      model: "gpt-compatible",
      stream: true,
      input: "Continue",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: response.created");
    expect(response.body).toContain("event: response.output_item.added");
    expect(response.body).toContain('"type":"response.output_text.delta"');
    expect(response.body).toContain('"delta":"Done"');
    expect(response.body).toContain('"type":"response.function_call_arguments.delta"');
    expect(response.body).toContain('"delta":"{\\"scope\\":"');
    expect(response.body).toContain("event: response.function_call_arguments.done");
    expect(response.body).toContain("event: response.completed");
    expect(response.body).toContain('"call_id":"call_7"');
    expect(response.body).toContain('"input_tokens":7');
    expect(response.body).toContain('"output_tokens":3');
  });

  it("streams Anthropic Messages as OpenAI Responses events", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "claude-compatible",
        max_tokens: 256,
        stream: true,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Continue" }],
        }],
        tools: [{
          name: "status_get",
          input_schema: { type: "object", properties: {} },
        }],
      });
      return sse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_anthropic_1","model":"claude-compatible","usage":{"input_tokens":11}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_8","name":"status_get","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"scope\\":\\"project\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    });
    const fixture = createFixture(apps, "anthropic", fetch_);
    const response = await injectAuthorized(fixture, "responses", {
      model: "claude-compatible",
      max_output_tokens: 256,
      stream: true,
      input: [{
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      }],
      tools: [{
        type: "function",
        name: "status_get",
        parameters: { type: "object", properties: {} },
      }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"id":"resp_anthropic_1"');
    expect(response.body).toContain('"type":"response.function_call_arguments.delta"');
    expect(response.body).toContain('"call_id":"toolu_8"');
    expect(response.body).toContain('"name":"status_get"');
    expect(response.body).toContain('"input_tokens":11');
    expect(response.body).toContain('"output_tokens":4');
    expect(response.body).toContain("event: response.completed");
  });

  it("routes Claude Code through an upstream Responses-only provider", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://openai-compatible.test/v1/responses",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "responses-only-model",
        instructions: "Use wallet context.",
        max_output_tokens: 300,
        store: false,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue." }],
        }],
        tools: [{
          type: "function",
          name: "status_get",
          parameters: { type: "object", properties: {} },
        }],
      });
      return json({
        id: "resp_upstream_1",
        object: "response",
        status: "completed",
        model: "responses-only-model-2026",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Checking." }],
          },
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "status_get",
            arguments: "{\"scope\":\"project\"}",
          },
        ],
        usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17 },
      });
    });
    const fixture = createFixture(
      apps,
      "openai",
      fetch_,
      "compatible-api",
      "openai-responses",
    );

    const response = await injectAuthorized(fixture, "messages", {
      model: "responses-only-model",
      max_tokens: 300,
      system: "Use wallet context.",
      messages: [{ role: "user", content: "Continue." }],
      tools: [{
        name: "status_get",
        input_schema: { type: "object", properties: {} },
      }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "responses-only-model-2026",
      content: [
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "call_1",
          name: "status_get",
          input: { scope: "project" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 13, output_tokens: 4 },
    });
  });

  it("converts an upstream Responses stream into Anthropic SSE", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "responses-only-model",
        stream: true,
        store: false,
      });
      return sse([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream_up","model":"responses-only-model"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Ready"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream_up","model":"responses-only-model","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7},"output":[]}}\n\n',
      ]);
    });
    const fixture = createFixture(
      apps,
      "openai",
      fetch_,
      "compatible-api",
      "openai-responses",
    );

    const response = await injectAuthorized(fixture, "messages", {
      model: "responses-only-model",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "Continue" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain('"type":"text_delta","text":"Ready"');
    expect(response.body).toContain('"stop_reason":"end_turn"');
    expect(response.body).toContain('"output_tokens":2');
    expect(response.body).toContain("event: message_stop");
  });

  it("maps provider errors into the caller protocol and preserves retry metadata", async () => {
    const anthropicFixture = createFixture(
      apps,
      "openai",
      vi.fn<typeof fetch>(async () =>
        json(
          { error: { message: "Upstream capacity reached", code: "overloaded" } },
          429,
          { "retry-after": "5", "x-request-id": "req_1" },
        ),
      ),
    );
    const anthropicResponse = await injectAuthorized(
      anthropicFixture,
      "messages",
      { model: "gpt-test", max_tokens: 10, messages: [] },
    );
    expect(anthropicResponse.statusCode).toBe(429);
    expect(anthropicResponse.headers["retry-after"]).toBe("5");
    expect(anthropicResponse.headers["x-request-id"]).toBe("req_1");
    expect(anthropicResponse.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Upstream capacity reached" },
    });

    const openAiFixture = createFixture(
      apps,
      "anthropic",
      vi.fn<typeof fetch>(async () =>
        json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "Bad provider key provider-secret-key",
            },
          },
          401,
        ),
      ),
    );
    const openAiResponse = await injectAuthorized(
      openAiFixture,
      "chat/completions",
      { model: "claude-test", messages: [] },
    );
    expect(openAiResponse.statusCode).toBe(401);
    expect(openAiResponse.json()).toEqual({
      error: {
        message: "Bad provider key [redacted]",
        type: "authentication_error",
        param: null,
        code: "authentication_error",
      },
    });
  });

  it("proxies same-protocol requests and responses without shape changes", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      });
      return json({
        id: "chat_same",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        custom_provider_field: true,
      });
    });
    const fixture = createFixture(apps, "openai", fetch_);
    const response = await injectAuthorized(fixture, "chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.json()).toEqual({
      id: "chat_same",
      choices: [{ message: { role: "assistant", content: "hello" } }],
      custom_provider_field: true,
    });
  });

  it("routes an unspecified custom source through one deterministic upstream format", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://custom-provider.test/v1/chat/completions",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "custom-model",
        messages: [{ role: "user", content: "hello" }],
      });
      return json({
        id: "chat_custom",
        model: "custom-model",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "hello" },
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    });
    const fixture = createFixture(
      apps,
      "custom",
      fetch_,
      "custom-endpoint",
      undefined,
      "https://custom-provider.test/v1",
    );

    const response = await injectAuthorized(fixture, "messages", {
      model: "custom-model",
      max_tokens: 20,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      model: "custom-model",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves Azure api-version and normalizes Ollama root URLs", async () => {
    const azureFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://resource.openai.azure.com/openai/deployments/main/chat/completions?api-version=2025-04-01-preview",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("api-key")).toBe("provider-secret-key");
      expect(headers.get("authorization")).toBeNull();
      return json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    const azure = createFixture(
      apps,
      "azure-openai",
      azureFetch,
      "compatible-api",
      "openai-chat-completions",
      "https://resource.openai.azure.com/openai/deployments/main?api-version=2025-04-01-preview",
    );
    expect((await injectAuthorized(azure, "chat/completions", {
      model: "deployment-model",
      messages: [],
    })).statusCode).toBe(200);

    const ollamaFetch = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      return json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    const ollama = createFixture(
      apps,
      "ollama",
      ollamaFetch,
      "local-service",
      "openai-chat-completions",
      "http://127.0.0.1:11434",
    );
    expect((await injectAuthorized(ollama, "chat/completions", {
      model: "qwen3",
      messages: [],
    })).statusCode).toBe(200);
  });

  it("defaults the official OpenAI API to Responses when no format is stored", async () => {
    const fetch_ = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-test",
        input: "Continue.",
      });
      return json({
        id: "resp_official",
        object: "response",
        status: "completed",
        model: "gpt-test",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      });
    });
    const fixture = createFixture(
      apps,
      "openai",
      fetch_,
      "official-api",
      undefined,
      "https://api.openai.com/v1",
    );

    const response = await injectAuthorized(fixture, "responses", {
      model: "gpt-test",
      input: "Continue.",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "resp_official" });
  });
});

interface Fixture {
  app: FastifyInstance;
  gateway: ModelGateway;
  token: string;
}

function createFixture(
  apps: FastifyInstance[],
  protocol: ModelApiProtocol,
  fetch_: typeof fetch,
  kind: ModelSourceKind = "compatible-api",
  apiFormat?: ModelApiFormat,
  endpoint?: string,
): Fixture {
  const authority = new ModelGatewayTokenAuthority({ key: Buffer.alloc(32, 7) });
  const gateway = new ModelGateway({
    baseUrl: "http://127.0.0.1:8787",
    fetch: fetch_,
    tokenAuthority: authority,
    resolveSource: async ({ sourceId, userId }) =>
      sourceId === "source-1" && userId === "user-1"
        ? {
            apiKey: "provider-secret-key",
            source: {
              id: sourceId,
              kind,
              protocol,
              ...(apiFormat ? { apiFormat } : {}),
              endpoint: endpoint ?? (
                protocol === "anthropic"
                  ? "https://anthropic.test"
                  : "https://openai-compatible.test/v1"
              ),
            },
          }
        : undefined,
  });
  const app = Fastify({ logger: false });
  registerModelGatewayRoutes(app, gateway);
  apps.push(app);
  return {
    app,
    gateway,
    token: authority.issue({ sourceId: "source-1", userId: "user-1" }),
  };
}

async function injectAuthorized(
  fixture: Fixture,
  path: "chat/completions" | "messages" | "responses",
  payload: Record<string, unknown>,
) {
  return await fixture.app.inject({
    method: "POST",
    url: `/v1/model-gateway/source-1/v1/${path}`,
    headers: { authorization: `Bearer ${fixture.token}` },
    payload,
  });
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          const bytes = encoder.encode(frame);
          const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
          controller.enqueue(bytes.slice(0, midpoint));
          controller.enqueue(bytes.slice(midpoint));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
