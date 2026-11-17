import {isSensitiveEvidenceKey} from "../shared/provenance.js";

// Inspect without returning source material or throwing a parser's raw input.
export function evidenceRedactionStatus(document) {
  // Corruption heuristics apply only to v1 captures. A v2 document's free text
  // went through the current redactor; "[1] Password: …" or "token=x;y=1" in
  // it is redacted text, not a leak, and must not cause the capture to be refused.
  const legacy=document?.redaction_version!=="structured-json-v2";
  let reason=null;
  function inspect(value,depth=0){
    if(reason)return;
    if(depth>64){reason="capture_depth_unverifiable";return;}
    if(typeof value==="string"){
      if(value==="[REDACTED]")return;
      // Plain text whose first line was redacted also starts with '['.
      if(/^\s*(?:\{|\[(?!REDACTED\]))/.test(value)){
        try{inspect(JSON.parse(value),depth+1);}catch{if(legacy && value.includes("[REDACTED]"))reason="malformed_json_capture";}
      }else if(/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]+/i.test(value))reason="unredacted_sensitive_field";
      // The v1 text redactor stopped at the first ';', leaving later cookie pairs.
      else if(legacy && /\[REDACTED\]["']?\s*;\s*[^\s=;"']+=/.test(value))reason="unredacted_sensitive_field";
    }else if(Array.isArray(value))value.forEach(v=>inspect(v,depth+1));
    else if(value && typeof value==="object")for(const [key,v]of Object.entries(value)){
      if(isSensitiveEvidenceKey(key) && v!=="[REDACTED]" && v!=null && v!=="")reason="unredacted_sensitive_field";
      else inspect(v,depth+1);
    }
  }
  inspect(document);
  return {safe:reason===null,reason};
}
