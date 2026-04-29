import { createHash } from 'crypto';

/**
 * Anonymizes IP by zeroing the last octet (IPv4) or last group (IPv6),
 * then returns a SHA-256 hash of the result.
 *
 * Examples:
 *   "192.168.1.45"          → sha256("192.168.1.0")
 *   "2001:db8::1234:5678"   → sha256("2001:db8::1234:0")
 */
export function hashIp(ip: string): string {
  const anonymized = anonymizeIp(ip);
  return createHash('sha256').update(anonymized).digest('hex');
}

export function anonymizeIp(ip: string): string {
  // IPv4
  if (ip.includes('.')) {
    return ip.replace(/\.\d+$/, '.0');
  }
  // IPv6
  if (ip.includes(':')) {
    return ip.replace(/:[0-9a-fA-F]+$/, ':0');
  }
  return ip;
}
