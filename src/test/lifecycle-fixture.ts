export const emptyLifecycleCatalog: typeof fetch = async () => new Response(JSON.stringify({ result: [] }), { headers: { "content-type": "application/json" } });
