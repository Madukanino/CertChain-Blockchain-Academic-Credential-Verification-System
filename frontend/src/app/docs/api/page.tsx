import { Card } from '@/components/ui/card';
import { Metadata } from 'next';
import { getSiteUrl } from '@/lib/siteUrl';

export const metadata: Metadata = {
    title: 'API Documentation | Acredia',
    description: 'Documentation for Acredia Public Verification API and Embeddable Widget',
};

export default function ApiDocsPage() {
    // Derived, never hardcoded: the embed snippet previously pointed at
    // `acredia-stellar.vercel.app`, which 404s — the live deployment is on a
    // different hostname. Handing developers a dead script URL is worse than
    // giving none, so it now follows NEXT_PUBLIC_SITE_URL like every other link.
    const siteUrl = getSiteUrl();

    return (
        <div className="container mx-auto max-w-4xl py-12 px-4">
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">API Documentation</h1>
                    <p className="mt-2 text-lg text-muted-foreground">
                        Integrate Acredia programmatic verification into your applications and websites.
                    </p>
                </div>

                <div className="space-y-12 mt-10">
                    <section id="verification-api">
                        <h2 className="text-2xl font-semibold border-b pb-2 mb-6">Public Verification API</h2>
                        <p className="text-muted-foreground mb-4">
                            The Acredia Public Verification API allows employers, ATS platforms, and partners to verify the authenticity, integrity, and revocation status of credentials programmatically.
                        </p>

                        <Card className="p-6 overflow-hidden">
                            <h3 className="text-lg font-medium mb-2">Verify a Credential</h3>
                            <div className="flex items-center gap-3 bg-secondary/30 p-3 rounded-md mb-4 border font-mono text-sm">
                                <span className="bg-primary/20 text-primary px-2 py-0.5 rounded text-xs font-bold">GET</span>
                                <span>/api/verify/[token]</span>
                            </div>

                            <div className="space-y-4 text-sm">
                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Path Parameters</h4>
                                    <ul className="list-disc list-inside text-muted-foreground ml-2">
                                        <li><code className="bg-muted px-1 py-0.5 rounded">token</code> - The unique credential token ID</li>
                                    </ul>
                                </div>
                                
                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Headers</h4>
                                    <ul className="list-disc list-inside text-muted-foreground ml-2">
                                        <li><code className="bg-muted px-1 py-0.5 rounded">Authorization</code> - Bearer &lt;Your-API-Key&gt;</li>
                                        <li className="mt-1">Alternatively, use <code className="bg-muted px-1 py-0.5 rounded">X-API-Key: &lt;Your-API-Key&gt;</code></li>
                                    </ul>
                                    <p className="text-xs text-muted-foreground mt-2 italic">Note: API keys can be generated in the Dashboard Settings (for Institutions). Anonymous requests are rate-limited heavily.</p>
                                </div>

                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Response (Success 200 OK)</h4>
                                    <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-4 rounded-md overflow-x-auto text-xs font-mono border mt-2">
{`{
  "success": true,
  "credential": {
    "tokenId": "did:acredia:...",
    "issuedAt": "2024-01-01T00:00:00Z",
    "revoked": false,
    "institutionName": "University of Technology",
    "credentialType": "Bachelor of Science",
    ...
  },
  "verification": {
    "verified": true,
    "revoked": false,
    "onChainMatch": true,
    "onChainFound": true,
    "issuerAuthorized": true,
    "issuerStatus": "active",
    "integrity": {
      "status": "match",
      "cidResolved": true
    }
  }
}`}
                                    </pre>
                                </div>
                            </div>
                        </Card>
                    </section>

                    <section id="batch-verification-api">
                        <h2 className="text-2xl font-semibold border-b pb-2 mb-6">Batch Verification API</h2>
                        <p className="text-muted-foreground mb-4">
                            Verify a cohort of credentials in a single HTTP request. Each token is evaluated independently and returns its own status without aborting the rest of the batch.
                        </p>

                        <Card className="p-6 overflow-hidden">
                            <h3 className="text-lg font-medium mb-2">Batch Verify Credentials</h3>
                            <div className="flex items-center gap-3 bg-secondary/30 p-3 rounded-md mb-4 border font-mono text-sm">
                                <span className="bg-primary/20 text-primary px-2 py-0.5 rounded text-xs font-bold">POST</span>
                                <span>/api/verify/batch</span>
                            </div>

                            <div className="space-y-4 text-sm">
                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Request Body &amp; Limits</h4>
                                    <p className="text-muted-foreground mb-2">
                                        Submit between 1 and 20 token IDs per request. Batches exceeding 20 tokens are rejected with <code className="bg-muted px-1 py-0.5 rounded">400 Bad Request</code>. Rate-limit quota is consumed proportionally to batch size (1 unit per token against the verify quota).
                                    </p>
                                    <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-4 rounded-md overflow-x-auto text-xs font-mono border">
{`{
  "tokens": ["token-valid", "token-revoked", "token-missing"]
}`}
                                    </pre>
                                </div>

                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Partial-Failure Semantics</h4>
                                    <p className="text-muted-foreground">
                                        A valid batch request returns <code className="bg-muted px-1 py-0.5 rounded">200 OK</code> with a per-token <code className="bg-muted px-1 py-0.5 rounded">results</code> array preserving input order. Individual failures never fail the entire batch: inspect each item&apos;s <code className="bg-muted px-1 py-0.5 rounded">status</code> (<code className="bg-muted px-1 py-0.5 rounded">verified</code>, <code className="bg-muted px-1 py-0.5 rounded">revoked</code>, <code className="bg-muted px-1 py-0.5 rounded">mismatch</code>, <code className="bg-muted px-1 py-0.5 rounded">not_found</code>, <code className="bg-muted px-1 py-0.5 rounded">invalid</code>, <code className="bg-muted px-1 py-0.5 rounded">unavailable</code>, or <code className="bg-muted px-1 py-0.5 rounded">error</code>) and <code className="bg-muted px-1 py-0.5 rounded">statusCode</code>.
                                    </p>
                                </div>

                                <div>
                                    <h4 className="font-semibold text-foreground mb-1">Response (200 OK)</h4>
                                    <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-4 rounded-md overflow-x-auto text-xs font-mono border mt-2">
{`{
  "success": true,
  "total": 3,
  "summary": {
    "verified": 1,
    "revoked": 1,
    "mismatch": 0,
    "notFound": 1,
    "failed": 0
  },
  "results": [
    { "token": "token-valid", "success": true, "status": "verified", "statusCode": 200, "credential": { ... }, "verification": { "verified": true, "revoked": false, ... } },
    { "token": "token-revoked", "success": true, "status": "revoked", "statusCode": 200, "credential": { ... }, "verification": { "verified": false, "revoked": true, ... } },
    { "token": "token-missing", "success": false, "status": "not_found", "statusCode": 404, "error": "Credential not found" }
  ]
}`}
                                    </pre>
                                </div>
                            </div>
                        </Card>
                    </section>

                    <section id="upgrade-policy">
                        <h2 className="text-2xl font-semibold border-b pb-2 mb-6">Contract Upgrade Policy</h2>
                        <p className="text-muted-foreground mb-4">
                            The on-chain credential contract is upgradeable so that bugs can be fixed without changing the contract address (which would break existing QR codes and verification links). To keep that power transparent to everyone who relies on a credential, upgrades are governed by an on-chain timelock — they cannot take effect the moment an operator decides to run them.
                        </p>
                        <Card className="p-6">
                            <ul className="space-y-3 text-sm text-muted-foreground list-disc list-inside">
                                <li><span className="text-foreground font-medium">Announced in advance.</span> Every upgrade must first be proposed on-chain, which emits a public <code className="bg-muted px-1 py-0.5 rounded">upg_prop</code> event and is readable by anyone via the contract&apos;s <code className="bg-muted px-1 py-0.5 rounded">get_pending_upgrade</code> method.</li>
                                <li><span className="text-foreground font-medium">Fixed waiting period.</span> A proposed upgrade can only be executed after a timelock of ~7 days (120,960 ledgers) has elapsed, giving credential holders and verifiers a window to inspect the proposed code before it goes live.</li>
                                <li><span className="text-foreground font-medium">Code-hash commitment.</span> A proposal commits to a specific WASM code hash, and execution must present that same hash — so the code that ships is exactly the code that was announced.</li>
                                <li><span className="text-foreground font-medium">Owner-gated and cancellable.</span> Only the contract owner can propose, cancel, or execute an upgrade, and a pending proposal can be withdrawn (<code className="bg-muted px-1 py-0.5 rounded">cancel_upgrade</code>) before the window elapses.</li>
                            </ul>
                            <p className="text-xs text-muted-foreground mt-4 italic">The emergency pause circuit-breaker is separate and immediate: it can halt state changes during an incident without waiting on the upgrade timelock, while never allowing code to be replaced without the announced waiting period.</p>
                        </Card>
                    </section>

                    <section id="embeddable-widget">
                        <h2 className="text-2xl font-semibold border-b pb-2 mb-6">Embeddable Widget</h2>
                        <p className="text-muted-foreground mb-4">
                            Drop a "Verify with Acredia" button directly into your website to allow your users to verify credentials seamlessly without leaving your page (opens a popup).
                        </p>

                        <Card className="p-6">
                            <h3 className="text-lg font-medium mb-4">Quickstart</h3>
                            
                            <div className="space-y-6">
                                <div>
                                    <p className="text-sm text-foreground font-semibold mb-2">1. Add the widget script to your page</p>
                                    <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-3 rounded-md overflow-x-auto text-xs font-mono border">
{`<script src="${siteUrl}/widget.js" async defer></script>`}
                                    </pre>
                                </div>
                                
                                <div>
                                    <p className="text-sm text-foreground font-semibold mb-2">2. Place the button container</p>
                                    <p className="text-xs text-muted-foreground mb-2">Add this div wherever you want the button to appear. Optional: Provide a token to pre-fill the verification.</p>
                                    <pre className="bg-[#1e1e1e] text-[#d4d4d4] p-3 rounded-md overflow-x-auto text-xs font-mono border">
{`<div id="acredia-verify-widget" data-token="OPTIONAL_TOKEN_ID"></div>`}
                                    </pre>
                                </div>

                                <div className="bg-secondary/30 p-4 rounded-md border flex items-center justify-between">
                                    <div className="text-sm">
                                        <p className="font-semibold">Result Preview</p>
                                        <p className="text-muted-foreground text-xs mt-1">What the button looks like on your site</p>
                                    </div>
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-2 bg-blue-700 hover:bg-blue-800 text-white font-semibold py-2.5 px-5 rounded-md shadow-sm transition-colors text-sm"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                        Verify with Acredia
                                    </button>
                                </div>
                            </div>
                        </Card>
                    </section>
                </div>
            </div>
        </div>
    );
}
