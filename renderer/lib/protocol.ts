// Re-export of the shared wire protocol. The single source lives in
// main/protocol.ts because nextron's main-process webpack only runs its TS
// loader inside main/, while the renderer build can compile anything under the
// project root. Renderer code imports from here; main imports './protocol'.

export * from '../../main/protocol'
