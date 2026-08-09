const d="co.undefineds.ai-connections",h=new Set(["providerCredentials","providerDefinitions","gatewayAccessKeys","quotaSnapshots"]);function S(e,r){if(!a(e))throw new Error("invalid_descriptor");if(e.appletId!==d)throw new Error("invalid_applet_id");const t=e.service;if(!a(t)||typeof t.webId!="string"||typeof t.label!="string"||!I(t.webId))throw new Error("invalid_service");if(!Array.isArray(e.resources)||e.resources.length===0)throw new Error("invalid_empty_resources");const n=m(r),c=new Set,o=e.resources.map(f=>y(f,n,c));return{appletId:d,service:{webId:t.webId,label:t.label},resources:o}}function y(e,r,t){if(!a(e)||typeof e.id!="string"||typeof e.url!="string"||e.mediaType!=="text/turtle"||!a(e.access))throw new Error("invalid_resource");if(!h.has(e.id)||t.has(e.id))throw new Error("invalid_resource");A(e.url);let n;try{n=new URL(e.url)}catch{throw new Error("invalid_resource")}if(!b(n,r))throw new Error("invalid_resource");return t.add(e.id),{id:e.id,url:n.href,mediaType:"text/turtle",access:g(e.access)}}function A(e){if(/%(?![0-9a-fA-F]{2})/.test(e)||/%(?:2f|5c)/i.test(e)||e.includes("\\"))throw new Error("invalid_resource");const r=_(e);if(u(r))throw new Error("invalid_resource");try{const t=decodeURIComponent(r);if(t.includes("\\")||u(t))throw new Error("invalid_resource")}catch{throw new Error("invalid_resource")}}function _(e){const r=e.split("#",1)[0]??e;return(r.split("?",1)[0]??r).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]*/i,"")}function u(e){return e.split("/").some(r=>r==="."||r==="..")}function g(e){if(Object.keys(e).some(t=>t!=="read"&&t!=="append"&&t!=="write")||e.read!==!0||e.append!==!0||e.write!==!0)throw new Error("invalid_resource");return{read:!0,append:!0,write:!0}}function m(e){const r=new URL(e);if(r.protocol!=="http:"&&r.protocol!=="https:")throw new Error("invalid_current_pod");return r.pathname.endsWith("/")||(r.pathname=`${r.pathname}/`),r}function b(e,r){return(e.protocol==="http:"||e.protocol==="https:")&&e.origin===r.origin&&e.pathname.startsWith(r.pathname)}function I(e){try{const r=new URL(e);return r.protocol==="http:"||r.protocol==="https:"}catch{return!1}}function a(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}const C="http://www.w3.org/ns/solid/acp#",E="http://www.w3.org/ns/auth/acl#";function w(e,{ownerWebId:r,serviceWebId:t},n=!0){const c=n?`
<#serviceAccess>
    a acp:AccessControl;
    acp:apply [
        a acp:Policy;
        acp:allow acl:Read, acl:Write;
        acp:anyOf [
            a acp:Matcher;
            acp:agent <${t}>
        ]
    ].
`:"",o=n?"<#ownerAccess>, <#serviceAccess>":"<#ownerAccess>";return`@prefix acl: <${E}>.
@prefix acp: <${C}>.

<#managed>
    a acp:AccessControlResource;
    acp:resource <${e}>;
    acp:accessControl ${o};
    acp:memberAccessControl ${o}.

<#ownerAccess>
    a acp:AccessControl;
    acp:apply [
        a acp:Policy;
        acp:allow acl:Read, acl:Write, acl:Control;
        acp:anyOf [
            a acp:Matcher;
            acp:agent <${r}>
        ]
    ].
${c}`}function R(e){const r=new URL(e);return r.pathname.endsWith("/")||(r.pathname=r.pathname.slice(0,r.pathname.lastIndexOf("/")+1)),r.toString()}function i(e){return new URL(".acr",e).toString()}function p(e){return[...new Set(e.resources.map(r=>R(r.url)))]}async function l(e,r,t){const n=await e(r,{method:"PUT",headers:{"content-type":"text/turtle"},body:t});if(!n.ok)throw await n.arrayBuffer().catch(()=>{}),new Error(`service_acr_write_failed:${n.status}`)}function s(e,r,t){return{status:r?"granted":"missing",resources:e.resources}}function U(e){const r=()=>{if(!e.ownerWebId)throw new Error("service_acr_owner_missing");return e.ownerWebId};return{async ensureAgentAccess(t){const n=r();for(const c of p(t))await l(e.authenticatedFetch,i(c),w(c,{ownerWebId:n,serviceWebId:t.service.webId}));return{status:"granted",resources:t.resources}},async inspectAgentAccess(t){try{for(const n of p(t)){const c=await e.authenticatedFetch(i(n),{headers:{accept:"text/turtle"}});if(!c.ok)return await c.arrayBuffer().catch(()=>{}),s(t,!1);const o=await c.text();if(!o.includes(`<${t.service.webId}>`)||!o.includes("acp:AccessControlResource"))return s(t,!1)}return s(t,!0)}catch{return s(t,!1)}},async revokeAgentAccess(t){const n=r();for(const c of p(t))await l(e.authenticatedFetch,i(c),w(c,{ownerWebId:n,serviceWebId:t.service.webId},!1));return{status:"missing",resources:t.resources}}}}export{U as c,S as p};
