// Keep this loader unbundled so peer resolution is anchored to the installed module.
exports.loadPeerSdk = () => require('@inrupt/solid-client-authn-node');
