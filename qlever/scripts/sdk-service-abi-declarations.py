"""Pure cross-check of existing native and client ABI declarations.

Inputs must be obtained from the caller's private immutable source capability.
This parser issues no origin or ABI qualification and contains no ABI values.
"""
import re

def declarations(header, adapter, runtime, client):
    def text(raw):
        if not isinstance(raw,bytes) or len(raw)>1024**2:
            raise ValueError('bounded actual source bytes required')
        return raw.decode('utf-8')
    header,adapter,runtime,client=map(text,(header,adapter,runtime,client))
    def one(pattern,source):
        rows=re.findall(pattern,source,re.MULTILINE)
        if len(rows)!=1:raise ValueError('unique reviewed ABI declaration required')
        return rows[0]
    physical=int(one(r'^#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION ([1-9][0-9]*)$',header))
    wire=int(one(r'^constexpr uint32_t kNativeSparqlAbiVersion = ([1-9][0-9]*);$',runtime))
    client_wire=int(one(r'^const NATIVE_SPARQL_ABI_VERSION = ([1-9][0-9]*);$',client))
    client_physical=int(one(r'^const PHYSICAL_BACKEND_ABI_VERSION = ([1-9][0-9]*);$',client))
    one(r'^extern "C" uint32_t xpod_qlever_adapter_abi_version\(void\) \{\n  (return XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;)\n\}$',adapter)
    for field,expression in [('abiVersion','kNativeSparqlAbiVersion'),
                             ('adapterAbiVersion','xpod_qlever_adapter_abi_version()'),
                             ('physicalBackendAbiVersion','XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION')]:
        one(r'^      \{"'+field+r'", ('+re.escape(expression)+r')\},$',runtime)
    if wire!=client_wire or physical!=client_physical:
        raise ValueError('native ready declarations disagree with actual client defaults')
    return dict(abiVersion=wire,adapterAbiVersion=physical,physicalBackendAbiVersion=physical)
