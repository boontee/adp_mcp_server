#!/usr/bin/env node
/**
 * MCP Server for IBM Automation Document Processing (ADP) API
 *
 * Exposes the following tools:
 *  - adp_list_analyzers       — list all configured analyzers for the project
 *  - adp_submit_document      — upload and submit a document for processing
 *  - adp_get_document_status  — poll the processing status of a submitted document
 *  - adp_get_document_results — retrieve the extracted JSON results
 *  - adp_get_document_pdf     — retrieve the annotated PDF output (base64)
 *  - adp_delete_document      — delete a processed document record
 *  - adp_list_documents       — list all documents submitted to the project
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import https from "https";
import { URL } from "url";
// ---------------------------------------------------------------------------
// Configuration — read from environment variables at startup
// ---------------------------------------------------------------------------
const BASE_URL = process.env.ADP_BASE_URL;
const PROJECT_ID = process.env.ADP_PROJECT_ID;
const ZEN_API_KEY = process.env.ADP_ZEN_API_KEY; // full header value, e.g. "ZenApiKey ..."
if (!BASE_URL) {
    console.error("FATAL: ADP_BASE_URL environment variable is required");
    process.exit(1);
}
if (!PROJECT_ID) {
    console.error("FATAL: ADP_PROJECT_ID environment variable is required");
    process.exit(1);
}
if (!ZEN_API_KEY) {
    console.error("FATAL: ADP_ZEN_API_KEY environment variable is required");
    process.exit(1);
}
function adpRequest(opts) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL);
        const requestOptions = {
            hostname: url.hostname,
            port: url.port ? parseInt(url.port) : 443,
            path: opts.path,
            method: opts.method ?? "GET",
            headers: {
                Authorization: ZEN_API_KEY.startsWith("ZenApiKey ") || ZEN_API_KEY.startsWith("Bearer ")
                    ? ZEN_API_KEY
                    : `ZenApiKey ${ZEN_API_KEY}`,
                ...opts.headers,
            },
            rejectUnauthorized: false, // TechZone demo certs are self-signed
        };
        const req = https.request(requestOptions, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        if (opts.body) {
            req.write(opts.body);
        }
        req.end();
    });
}
/** Build the API base path for a project resource. */
function apiPath(resource, projectId) {
    const pid = projectId ?? PROJECT_ID;
    // ADP REST API base: /adp/aca/v1/projects/{projectId}/{resource}
    return `/adp/aca/v1/projects/${encodeURIComponent(pid)}/${resource}`;
}
/** Multipart form-data builder (no external deps). */
function buildMultipart(fields, fileField, fileName, fileBuffer, mimeType) {
    const boundary = `----McpAdpBoundary${Date.now()}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { boundary, body: Buffer.concat(parts) };
}
// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "adp-mcp-server", version: "1.0.0" });
// ---------------------------------------------------------------------------
// Tool: adp_list_analyzers
// ---------------------------------------------------------------------------
server.registerTool("adp_list_analyzers", {
    description: "List all analyzers (document classifiers and extractors) configured for the ADP project.",
    inputSchema: z.object({}),
}, async () => {
    try {
        const res = await adpRequest({ path: apiPath("analyzers") });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return { content: [{ type: "text", text: res.body.toString() }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_submit_document
// ---------------------------------------------------------------------------
server.registerTool("adp_submit_document", {
    description: "Upload a local file to ADP and submit it for analysis. Returns the document record ID needed for status polling.",
    inputSchema: z.object({
        file_path: z
            .string()
            .describe("Absolute path to the document file on the local filesystem (PDF, PNG, TIFF, …)"),
        analyzer_id: z
            .string()
            .optional()
            .describe("Analyzer ID to use. If omitted, ADP uses the project default. Use adp_list_analyzers to discover IDs."),
    }),
}, async ({ file_path, analyzer_id }) => {
    try {
        const resolvedPath = path.resolve(file_path);
        if (!fs.existsSync(resolvedPath)) {
            return {
                content: [{ type: "text", text: `File not found: ${resolvedPath}` }],
                isError: true,
            };
        }
        const fileBuffer = fs.readFileSync(resolvedPath);
        const fileName = path.basename(resolvedPath);
        const ext = path.extname(fileName).toLowerCase();
        const mimeMap = {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".tif": "image/tiff",
            ".tiff": "image/tiff",
        };
        const mimeType = mimeMap[ext] ?? "application/octet-stream";
        const fields = {
            jsonOptions: "HR,DC,KVP,TH,OCR,SN,MT,CB,ST,DS,CHAR",
            pdfOptions: "OR",
            responseType: "all",
        };
        if (analyzer_id)
            fields["analyzerId"] = analyzer_id;
        const { boundary, body } = buildMultipart(fields, "file", fileName, fileBuffer, mimeType);
        const submitPath = apiPath("analyzers");
        const res = await adpRequest({
            method: "POST",
            path: submitPath,
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": String(body.length),
            },
            body,
        });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        const responseText = res.body.toString();
        let docId;
        try {
            const parsed = JSON.parse(responseText);
            docId = parsed?.result?.[0]?.data?.analyzerId ?? parsed?.documentId ?? parsed?.id ?? parsed?.recordId;
        }
        catch {
            // non-JSON fallback
        }
        return {
            content: [
                {
                    type: "text",
                    text: docId
                        ? `Document submitted successfully. Document ID: ${docId}\n\nFull response:\n${responseText}`
                        : responseText,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_get_document_status
// ---------------------------------------------------------------------------
server.registerTool("adp_get_document_status", {
    description: "Get the current processing status of a document previously submitted to ADP. Poll this until status is 'processed' or 'failed'.",
    inputSchema: z.object({
        document_id: z.string().describe("Document record ID returned by adp_submit_document"),
    }),
}, async ({ document_id }) => {
    try {
        const res = await adpRequest({
            path: apiPath(`analyzers/${encodeURIComponent(document_id)}`),
        });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return { content: [{ type: "text", text: res.body.toString() }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_get_document_results
// ---------------------------------------------------------------------------
server.registerTool("adp_get_document_results", {
    description: "Retrieve the extracted JSON results from a processed ADP document. The document must have status 'processed' before calling this.",
    inputSchema: z.object({
        document_id: z.string().describe("Document record ID"),
    }),
}, async ({ document_id }) => {
    try {
        const res = await adpRequest({
            path: apiPath(`analyzers/${encodeURIComponent(document_id)}/json`),
        });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return { content: [{ type: "text", text: res.body.toString() }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_get_document_pdf
// ---------------------------------------------------------------------------
server.registerTool("adp_get_document_pdf", {
    description: "Download the ADP-annotated PDF of a processed document and save it to a local path.",
    inputSchema: z.object({
        document_id: z.string().describe("Document record ID"),
        output_path: z
            .string()
            .describe("Absolute local path where the annotated PDF should be saved"),
    }),
}, async ({ document_id, output_path }) => {
    try {
        const res = await adpRequest({
            path: apiPath(`analyzers/${encodeURIComponent(document_id)}/pdf`),
            headers: { Accept: "application/pdf" },
        });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        const resolvedOut = path.resolve(output_path);
        fs.writeFileSync(resolvedOut, res.body);
        return {
            content: [{ type: "text", text: `Annotated PDF saved to: ${resolvedOut} (${res.body.length} bytes)` }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_delete_document
// ---------------------------------------------------------------------------
server.registerTool("adp_delete_document", {
    description: "Delete a document record and its extracted data from ADP.",
    inputSchema: z.object({
        document_id: z.string().describe("Document record ID to delete"),
    }),
}, async ({ document_id }) => {
    try {
        const res = await adpRequest({
            method: "DELETE",
            path: apiPath(`analyzers/${encodeURIComponent(document_id)}`),
        });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return {
            content: [{ type: "text", text: `Document ${document_id} deleted successfully.` }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_list_documents
// ---------------------------------------------------------------------------
server.registerTool("adp_list_documents", {
    description: "List all documents submitted to the ADP project, with their current status.",
    inputSchema: z.object({
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of documents to return (default: 20)"),
        offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Number of documents to skip for pagination (default: 0)"),
    }),
}, async ({ limit = 20, offset = 0 }) => {
    try {
        const queryPath = apiPath("analyzers");
        const res = await adpRequest({ path: queryPath });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return { content: [{ type: "text", text: res.body.toString() }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Tool: adp_get_ontology
// ---------------------------------------------------------------------------
server.registerTool("adp_get_ontology", {
    description: "Retrieve the ADP project ontology — the full list of document classes, key classes, and fields the project is configured to extract.",
    inputSchema: z.object({}),
}, async () => {
    try {
        const res = await adpRequest({ path: apiPath("ontology") });
        if (res.status >= 400) {
            return {
                content: [{ type: "text", text: `ADP error ${res.status}: ${res.body.toString()}` }],
                isError: true,
            };
        }
        return { content: [{ type: "text", text: res.body.toString() }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("adp-mcp-server running on stdio");
    console.error(`  BASE_URL:   ${BASE_URL}`);
    console.error(`  PROJECT_ID: ${PROJECT_ID}`);
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
