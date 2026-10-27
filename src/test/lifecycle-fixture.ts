export const emptyLifecycleCatalog: typeof fetch = async () => new Response(JSON.stringify({ result: [] }), { headers: { "content-type": "application/json" } });

export const supportedNodeProduct = { name: "nodejs", label: "Node.js", category: "lang", aliases: ["node"], releases: [
  { name: "22", isEol: false, eolFrom: "2035-04-30", releaseDate: "2024-04-24", latest: { name: "22.20.0", date: "2025-10-01" } }
] };
export const supportedNodeCatalog: typeof fetch = async () => new Response(JSON.stringify({ result: [supportedNodeProduct] }), { headers: { "content-type": "application/json" } });
