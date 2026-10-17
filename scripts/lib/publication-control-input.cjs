'use strict';
/** Route validation only. Immutable selectors and every admission remain owned
 * by run-independent-publication; this function issues no capability. */
function validatePublicationControlInput(input) {
  const keys=['event','ref','operation','sourceSha','mode','coordinates'];
  if(!input || typeof input!=='object' || Object.keys(input).length!==keys.length || keys.some(key=>!Object.hasOwn(input,key))
    || input.event!=='workflow_dispatch' || input.ref!=='refs/heads/staging'
    || input.operation!=='independent-publication' || !['prepare','publish'].includes(input.mode)
    || typeof input.sourceSha!=='string' || !/^[a-f0-9]{40}$/.test(input.sourceSha)
    || typeof input.coordinates!=='string' || Buffer.byteLength(input.coordinates)>1024*1024) {
    throw Error('Invalid independent publication control route');
  }
  let request;try{request=JSON.parse(input.coordinates);}catch{throw Error('Invalid independent publication selector JSON');}
  if(!request || request.schemaVersion!==2 || request.sourceSha!==input.sourceSha || !Array.isArray(request.products)
    || request.products.length<1 || request.products.length>128)throw Error('Publication selector source does not match control source');
  return Object.freeze({sourceSha:input.sourceSha,mode:input.mode});
}
if(require.main===module)validatePublicationControlInput({event:process.env.CONTROL_EVENT,ref:process.env.CONTROL_REF,
 operation:process.env.CONTROL_OPERATION,sourceSha:process.env.CONTROL_SOURCE_SHA,mode:process.env.CONTROL_MODE,coordinates:process.env.CONTROL_COORDINATES});
module.exports={validatePublicationControlInput};
