import { describe, expect, it } from "vitest";
import { humanBytes } from "../src/types";

describe("humanBytes", () => {
  it("formats byte counts in binary units, deterministically", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1)).toBe("1 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(1024)).toBe("1 KiB");
    expect(humanBytes(1536)).toBe("1.5 KiB");
    expect(humanBytes(842609220)).toBe("803.6 MiB");
    expect(humanBytes(1073741824)).toBe("1 GiB");
  });

  it("rejects invalid counts instead of rendering garbage", () => {
    expect(humanBytes(-5)).toBe("0 B");
    expect(humanBytes(Number.NaN)).toBe("0 B");
    expect(humanBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
