import { describe, expect, it } from "vitest";

import { isPublicAddress } from "@/lib/slack/tools/web";

describe("isPublicAddress", () => {
  it("blocks IPv4 RFC1918 ranges", () => {
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("172.16.0.1")).toBe(false);
    expect(isPublicAddress("172.31.255.255")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
  });
  it("blocks IPv4 loopback / link-local / 0.0.0.0", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("0.0.0.0")).toBe(false);
  });
  it("blocks IPv4 multicast/reserved", () => {
    expect(isPublicAddress("224.0.0.1")).toBe(false);
    expect(isPublicAddress("239.255.255.250")).toBe(false);
  });
  it("allows public IPv4", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
  it("blocks IPv6 loopback / link-local / unique-local", () => {
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
  });
  it("blocks IPv6 multicast", () => {
    expect(isPublicAddress("ff02::1")).toBe(false);
  });
  it("blocks IPv4-mapped IPv6 to private space", () => {
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });
  it("allows public IPv6", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
