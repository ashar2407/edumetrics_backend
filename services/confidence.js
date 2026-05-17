// services/confidence.js
// Re-exports from fuzzyMapper.js so other modules can import
// confidence utilities without circular dependencies.

const {
  getConfidenceLevel,
  requiresAiAssist,
  mergeConfidence,
  serializeMapping,
} = require('./fuzzyMapper');

module.exports = {
  getConfidenceLevel,
  requiresAiAssist,
  mergeConfidence,
  serializeMapping,
};
