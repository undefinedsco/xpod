console.error('[patch] loaded');
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(modulePath) {
  const exported = originalRequire.apply(this, arguments);
  if (modulePath.includes('ConfigPreprocessor')) {
    console.error('[patch] saw', modulePath);
  }
  if (modulePath.includes('ConfigPreprocessorComponent')) {
    console.error('[patch] instrumenting', modulePath);
    const target = exported.ConfigPreprocessorComponent;
    if (!target || !target.prototype) {
      console.error('[patch] target missing on', modulePath);
      return exported;
    }
    const originalCanHandle = target.prototype.canHandle;
    target.prototype.canHandle = function(config) {
      try {
        return originalCanHandle.call(this, config);
      } catch (error) {
        const value = config?.value ?? '(no-value)';
        try {
          const types = config?.properties?.types?.map?.((resource) => resource?.value ?? '?');
          console.error('CAN_HANDLE_FAILURE', value, types);
        } catch (innerError) {
          console.error('CAN_HANDLE_FAILURE', value);
        }
        throw error;
      }
    };
  } else if (modulePath.includes('ConfigPreprocessorComponentMapped.js')) {
    console.error('[patch] instrumenting mapped', modulePath);
  }
  return exported;
};
