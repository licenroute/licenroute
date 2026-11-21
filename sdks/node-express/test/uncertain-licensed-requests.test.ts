import { describe, expect, it } from "vitest";
import { UncertainLicensedRequests } from "../src/uncertain-licensed-requests.ts";

describe("BL-16: bounded uncertain licensed retry receipt", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const token = "bgat_abcdefgh_" + "A".repeat(43);

  it("only replays the same token, method, route and ID twice", () => {
    const retry = new UncertainLicensedRequests();
    retry.mark(id, "GET", "/datos/1", token, 100);
    expect(retry.consume(id, "POST", "/datos/1", token, 101)).toBe(false);
    expect(retry.consume(id, "GET", "/datos/2", token, 101)).toBe(false);
    expect(retry.consume(id, "GET", "/datos/1", token + "B", 101)).toBe(false);
    expect(retry.consume("different", "GET", "/datos/1", token, 101)).toBe(false);
    expect(retry.consume(id, "GET", "/datos/1", token, 102)).toBe(true);
    expect(retry.consume(id, "GET", "/datos/1", token, 103)).toBe(true);
    expect(retry.consume(id, "GET", "/datos/1", token, 104)).toBe(false);
  });

  it("expires and bounds memory, and never re-arms an existing receipt", () => {
    const retry = new UncertainLicensedRequests(100, 2);
    retry.mark(id, "GET", "/datos/1", token, 100);
    expect(retry.consume(id, "GET", "/datos/1", token, 199)).toBe(true);
    retry.mark(id, "GET", "/datos/1", token, 199);
    expect(retry.consume(id, "GET", "/datos/1", token, 199)).toBe(true);
    expect(retry.consume(id, "GET", "/datos/1", token, 199)).toBe(false);
    expect(retry.consume(id, "GET", "/datos/1", token, 200)).toBe(false);
    retry.mark("second", "GET", "/datos/1", token, 201);
    retry.mark("third", "GET", "/datos/1", token, 202);
    expect(retry.consume(id, "GET", "/datos/1", token, 203)).toBe(false);
    retry.forget("second");
    expect(retry.consume("second", "GET", "/datos/1", token, 203)).toBe(false);
    retry.clear();
    expect(retry.consume("third", "GET", "/datos/1", token, 203)).toBe(false);
  });
});
