import { describe, expect, it, vi } from "vitest";
import {
  ensureLocalService,
  inspectLocalService,
  LocalServicePortError,
  resolveDesktopPort,
  type ServiceInspection,
} from "./service-runtime.js";

describe("resolveDesktopPort", () => {
  it("uses the desktop default", () => {
    expect(resolveDesktopPort(undefined)).toBe(8787);
  });

  it.each(["0", "65536", "8.5", "http", " 8787"])(
    "rejects invalid port %s",
    (value) => {
      expect(() => resolveDesktopPort(value)).toThrow(
        "ONE_STATUS_PORT must be an integer between 1 and 65535.",
      );
    },
  );
});

describe("inspectLocalService", () => {
  it("recognizes a One Status health response", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ service: "one-status-api", status: "ok" }),
    );

    await expect(
      inspectLocalService("http://127.0.0.1:8787", fetchImplementation),
    ).resolves.toBe("one-status");
  });

  it("marks another HTTP service as occupied", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({ status: "ok" }),
    );

    await expect(
      inspectLocalService("http://127.0.0.1:8787", fetchImplementation),
    ).resolves.toBe("occupied");
  });

  it("marks a non-JSON HTTP response as occupied", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("ready", { status: 200 }),
    );

    await expect(
      inspectLocalService("http://127.0.0.1:8787", fetchImplementation),
    ).resolves.toBe("occupied");
  });

  it("marks a connection failure as unreachable", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      inspectLocalService("http://127.0.0.1:8787", fetchImplementation),
    ).resolves.toBe("unreachable");
  });
});

describe("ensureLocalService", () => {
  it("reuses an existing healthy service", async () => {
    const start = vi.fn();
    const service = await ensureLocalService({
      inspect: inspectionSequence("one-status"),
      start,
    });

    expect(service.ownership).toBe("existing");
    expect(service.baseUrl).toBe("http://127.0.0.1:8787");
    expect(start).not.toHaveBeenCalled();
  });

  it("starts and closes an embedded service once", async () => {
    const close = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ close }));
    const service = await ensureLocalService({
      inspect: inspectionSequence("unreachable"),
      port: 9876,
      start,
    });

    expect(service.ownership).toBe("embedded");
    expect(service.baseUrl).toBe("http://127.0.0.1:9876");
    expect(start).toHaveBeenCalledWith(9876);
    await service.close();
    await service.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a port occupied by an unrelated HTTP service", async () => {
    const start = vi.fn();
    await expect(
      ensureLocalService({
        inspect: inspectionSequence("occupied"),
        start,
      }),
    ).rejects.toBeInstanceOf(LocalServicePortError);
    expect(start).not.toHaveBeenCalled();
  });

  it("reuses One Status when another process wins the startup race", async () => {
    const addressInUse = Object.assign(new Error("listen failed"), {
      code: "EADDRINUSE",
    });
    const service = await ensureLocalService({
      inspect: inspectionSequence("unreachable", "one-status"),
      start: vi.fn(async () => {
        throw addressInUse;
      }),
    });

    expect(service.ownership).toBe("existing");
  });

  it("reports a startup race with an unrelated listener", async () => {
    const addressInUse = Object.assign(new Error("listen failed"), {
      code: "EADDRINUSE",
    });
    await expect(
      ensureLocalService({
        inspect: inspectionSequence("unreachable", "occupied"),
        start: vi.fn(async () => {
          throw addressInUse;
        }),
      }),
    ).rejects.toMatchObject({ name: "LocalServicePortError", port: 8787 });
  });

  it("preserves non-port startup errors", async () => {
    const databaseError = new Error("database unavailable");
    await expect(
      ensureLocalService({
        inspect: inspectionSequence("unreachable"),
        start: vi.fn(async () => {
          throw databaseError;
        }),
      }),
    ).rejects.toBe(databaseError);
  });
});

function inspectionSequence(
  ...results: ServiceInspection[]
): (baseUrl: string) => Promise<ServiceInspection> {
  let index = 0;
  return async () => results[Math.min(index++, results.length - 1)]!;
}
