// Re-export of the shared presets. The single source lives in main/presets.ts
// so the session server's rule engine can resolve preset IDs (same pattern as
// lib/protocol.ts). Renderer code keeps importing from here.

export * from '../../main/presets'
