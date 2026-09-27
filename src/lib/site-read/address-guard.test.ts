import { describe, expect, it } from "vitest";
import { blockedAddress, blockedHostname, parseIPv6 } from "./address-guard";

// Fill From Their Site reads a page at an address a person pasted. These are the addresses the
// server must never reach on anyone's behalf, IPv4 and IPv6, and the public ones it may.
describe("blockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.254",
    "0.0.0.0",
    "0.1.2.3",
    "192.0.2.10",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("refuses IPv4 %s", (ip) => {
    expect(blockedAddress(ip)).not.toBeNull();
  });

  it.each([
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fd00:ec2::254", // AWS metadata over IPv6
    "fdff:ffff::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe", // the same, in hex
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe", // NAT64 of the metadata address
    "2001:db8::1",
    "2001::1", // Teredo
    "2002:a9fe:a9fe::1", // 6to4
    "[::1]",
  ])("refuses IPv6 %s", (ip) => {
    expect(blockedAddress(ip)).not.toBeNull();
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "lets public %s through",
    (ip) => {
      expect(blockedAddress(ip)).toBeNull();
    },
  );

  it("refuses anything that isn't an IP at all", () => {
    expect(blockedAddress("example.com")).not.toBeNull();
    expect(blockedAddress("1.2.3")).not.toBeNull();
    expect(blockedAddress("1.2.3.256")).not.toBeNull();
    expect(blockedAddress("1::2::3")).not.toBeNull();
  });

  it("parses IPv6 forms into eight groups", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:10.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIPv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("blockedHostname", () => {
  it.each(["localhost", "api.localhost", "printer.local", "metadata.google.internal", "router.home.arpa", "intranet", "metadata"])(
    "refuses %s before DNS is asked",
    (h) => {
      expect(blockedHostname(h)).not.toBeNull();
    },
  );
  it.each(["pge.com", "www.sierracounty.ca.gov", "127.0.0.1", "[::1]"])("leaves %s to the address check", (h) => {
    expect(blockedHostname(h)).toBeNull();
  });
});
