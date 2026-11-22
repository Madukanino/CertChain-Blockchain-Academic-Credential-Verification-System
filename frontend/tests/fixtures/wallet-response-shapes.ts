/**
 * Sanitized wallet response-shape fixtures for adapter normalization tests (#74).
 *
 * These represent the real response shapes returned by each supported wallet
 * adapter when signing a message. The adapter must normalize all of them to
 * a consistent `{ signedMessage: string }` shape (Uint8Array → base64,
 * hex → base64, already-base64 → pass-through).
 *
 * Sources:
 *  - Freighter, Albedo, LOBSTR, Hana, OneKey: return `{ signedMessage: string }`
 *    where the string is a base64-encoded ed25519 signature.
 *  - xBull, Rabet: return `{ signedMessage: Uint8Array }` — must be converted to base64.
 *  - Bitget: returns `{ signedMessage: string }` as a hex string — must be decoded and
 *    re-encoded to base64. (See README.md:436-437 and the adapter source.)
 *  - HotWallet (HOT): `isAvailable` traps are documented in TEST_STRATEGY.md:197-235;
 *    this fixture reflects the shape when the wallet IS reachable.
 *
 * Each fixture contains a `raw` property (the value the wallet actually returns)
 * and an `expected` property (the base64 string the adapter must produce).
 *
 * These fixtures are used in walletAdapter.normalization.test.ts.
 */

export const SAMPLE_SIGNATURE_BYTES = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
  0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
  0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);

export const SAMPLE_SIGNATURE_BASE64 = Buffer.from(SAMPLE_SIGNATURE_BYTES).toString('base64');
export const SAMPLE_SIGNATURE_HEX = Buffer.from(SAMPLE_SIGNATURE_BYTES).toString('hex');

/** Freighter, Albedo, LOBSTR, Hana, OneKey — already base64 */
export const freighterSignMessageResponse = {
  raw: { signedMessage: SAMPLE_SIGNATURE_BASE64 },
  expected: SAMPLE_SIGNATURE_BASE64,
};

/** xBull — returns a Uint8Array that the adapter must base64-encode */
export const xbullSignMessageResponse = {
  raw: { signedMessage: SAMPLE_SIGNATURE_BYTES },
  expected: SAMPLE_SIGNATURE_BASE64,
};

/** Rabet — also returns a Uint8Array */
export const rabetSignMessageResponse = {
  raw: { signedMessage: SAMPLE_SIGNATURE_BYTES },
  expected: SAMPLE_SIGNATURE_BASE64,
};

/** Bitget — returns a hex string that the adapter must convert to base64 */
export const bitgetSignMessageResponse = {
  raw: { signedMessage: SAMPLE_SIGNATURE_HEX },
  expected: SAMPLE_SIGNATURE_BASE64,
};

/** HotWallet (HOT) — base64, same shape as Freighter */
export const hotwalletSignMessageResponse = {
  raw: { signedMessage: SAMPLE_SIGNATURE_BASE64 },
  expected: SAMPLE_SIGNATURE_BASE64,
};

export const ALL_WALLET_FIXTURES = [
  { wallet: 'freighter', ...freighterSignMessageResponse },
  { wallet: 'albedo', ...freighterSignMessageResponse },
  { wallet: 'lobstr', ...freighterSignMessageResponse },
  { wallet: 'hana', ...freighterSignMessageResponse },
  { wallet: 'onekey', ...freighterSignMessageResponse },
  { wallet: 'klever', ...freighterSignMessageResponse },
  { wallet: 'xbull', ...xbullSignMessageResponse },
  { wallet: 'rabet', ...rabetSignMessageResponse },
  { wallet: 'bitget', ...bitgetSignMessageResponse },
  { wallet: 'hotwallet', ...hotwalletSignMessageResponse },
];
