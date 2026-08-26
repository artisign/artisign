import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readJsonBody, PayloadTooLargeError } from "./json.js";

/** Minimal IncomingMessage stand-in: readJsonBody only uses `.on` (data/end/error). */
function fakeRequest(): IncomingMessage & { emit: EventEmitter["emit"] } {
  return new EventEmitter() as unknown as IncomingMessage & { emit: EventEmitter["emit"] };
}

describe("readJsonBody", () => {
  it("parses a normal JSON body", async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit("data", Buffer.from(JSON.stringify({ a: 1 })));
    req.emit("end");
    await expect(promise).resolves.toEqual({ a: 1 });
  });

  it("resolves {} for an empty body", async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit("end");
    await expect(promise).resolves.toEqual({});
  });

  it("rejects a plain Error for invalid JSON", async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit("data", Buffer.from("not json"));
    req.emit("end");
    await expect(promise).rejects.toThrow(/not valid JSON/);
  });

  it("rejects PayloadTooLargeError once the body exceeds the byte limit, without buffering the whole thing", async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    const oversized = Buffer.alloc(300 * 1024, "a"); // over the 256KB limit
    req.emit("data", oversized);
    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});
