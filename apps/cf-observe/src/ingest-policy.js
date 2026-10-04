import { HttpError } from './util.js';

const MASK = '[REDACTED]';
const sensitiveNames = ['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'token', 'apikey', 'privatekey', 'secretkey', 'accesskey', 'credential', 'credentials', 'sessionid', 'connectionstring', 'baggage'];
function sensitive(key) {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    return sensitiveNames.some(name => normalized === name || normalized.endsWith(name));
}
/** Best-effort credential filtering, not a general PII detector. Apply before any durable write. */
export function applyIngestPolicy(decoded) {
    let changed = false, visited = 0;
    function mask(value) {
        if (value !== MASK)
            changed = true;
        return MASK;
    }
    function text(value, depth) {
        // Console exporters often wrap structured JSON in an OTLP stringValue.
        if (/^\s*[\[{]/.test(value)) {
            let parsed;
            try { parsed = JSON.parse(value); } catch { /* Plain log text. */ }
            if (parsed && typeof parsed === 'object') {
                const previous = changed;
                changed = false;
                const filtered = visit(parsed, depth + 1);
                const nestedChanged = changed;
                changed = previous || nestedChanged;
                if (nestedChanged)
                    return JSON.stringify(filtered);
            }
        }
        return value
            .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, match => {
                try {
                    const url = new URL(match);
                    if (!url.username && !url.password)
                        return match;
                    url.username = '';
                    url.password = '';
                    changed = true;
                    return url.toString();
                }
                catch { return mask('malformed URL'); }
            })
            .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, (_match, scheme) => `${scheme} ${mask('credential')}`)
            .replace(/([?&])([^\s?&#=]+)=([^\s&#]*)/g, (match, separator, key) => {
                let decodedKey = key;
                try { decodedKey = decodeURIComponent(key); } catch { /* Match literal malformed keys. */ }
                return sensitive(decodedKey) ? `${separator}${key}=${mask('query')}` : match;
            })
            .replace(/(\b(?:set-cookie|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]+)/gi, (_match, prefix) => `${prefix}"${mask('cookie header')}"`)
            .replace(/(\b(?:authorization|proxy-authorization|password|passwd|client[_-]?secret|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&}\]]+)/gi, (_match, prefix) => `${prefix}"${mask('assignment')}"`)
            .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,})\b/g, () => mask('recognizable credential'));
    }
    function visit(value, depth = 0) {
        if (++visited > 100000 || depth > 40)
            throw new HttpError(413, 'Telemetry structure exceeds the filtering safety budget');
        if (typeof value === 'string')
            return text(value, depth);
        if (Array.isArray(value))
            return value.map(item => visit(item, depth + 1));
        if (!value || typeof value !== 'object')
            return value;
        const attribute = typeof value.key === 'string' && Object.hasOwn(value, 'value') && sensitive(value.key);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (attribute && key === 'value') {
                changed = true;
                return [key, { stringValue: MASK }];
            }
            return [key, sensitive(key) ? mask(item) : visit(item, depth + 1)];
        }));
    }
    const payload = visit(decoded.payload);
    const result = { ...decoded, payload, redacted: changed, redactionPolicy: 'credentials-v1' };
    // Unknown protobuf fields are not decoded and cannot be inspected by the policy.
    // Store filtered decoded payload only; never retain an opaque bypass to the filter.
    if (decoded.wireBase64 !== undefined) {
        delete result.wireBase64;
        result.rawWireOmitted = true;
    }
    return result;
}
