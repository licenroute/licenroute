import { BlockList, isIP } from "node:net";
import { m } from "./messages.ts";

/** IP canónica: IPv4 mapeada (::ffff:a.b.c.d) como IPv4; resto tal cual si es válida. */
export function cleanIp(value: string | undefined | null): string | null {
  if (!value) return null;
  const ip = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  return isIP(ip) ? ip : null;
}

export function buildTrustList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = "", prefix] = cidr.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (!isIP(address)) throw new Error(m("ip.invalid_proxy", { cidr }));
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

const trusted = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/**
 * IP del cliente (fixtures/client-ip.json, threat model T3). Solo se lee X-Forwarded-For si la
 * conexión viene de un proxy de confianza; se recorre de derecha a izquierda y la primera IP
 * no confiable es el cliente. Una entrada inválida detiene el recorrido.
 */
export function resolveClientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustList: BlockList): string | null {
  let client = cleanIp(remoteAddress);
  if (!client || !trusted(trustList, client)) return client;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!header) return client;
  const hops = header.split(",").map((h) => h.trim()).filter((h) => h !== "");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = cleanIp(hops[i]);
    if (!hop) return client;
    client = hop;
    if (!trusted(trustList, hop)) return hop;
  }
  return client;
}
