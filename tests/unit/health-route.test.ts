import { describe, expect, it } from "vitest";
import { GET, buildHealthPayload } from "@/app/api/health/route";

describe("health endpoint", () => {
  it("reports the service as up without requiring any credential", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body: unknown = await response.json();
    expect(body).toMatchObject({ status: "ok", service: "razorpay-agentic-commerce" });
  });

  it("never discloses configuration values or credential state", () => {
    const payload = buildHealthPayload(new Date("2026-01-01T00:00:00.000Z"));
    expect(Object.keys(payload).sort()).toEqual([
      "environment",
      "service",
      "status",
      "timestamp",
    ]);
    expect(payload.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});
