import { createContext, useContext, useRef, useState } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import type { DataCategory, SessionCatalog } from '../../shared/sessionData'

interface ArchiveWorkspace {
  catalog: SessionCatalog | null
  setCatalog: Dispatch<SetStateAction<SessionCatalog | null>>
  sessionId: string
  setSessionId: Dispatch<SetStateAction<string>>
  category: DataCategory
  setCategory: Dispatch<SetStateAction<DataCategory>>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  filesRef: RefObject<Map<string, File>>
}
const ArchiveContext = createContext<ArchiveWorkspace | null>(null)

// File objects stay in this window's memory while navigating; raw data is never persisted here.
export function SessionArchiveProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<SessionCatalog | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [category, setCategory] = useState<DataCategory>('recordings')
  const [query, setQuery] = useState('')
  const filesRef = useRef(new Map<string, File>())
  return (
    <ArchiveContext.Provider
      value={{
        catalog,
        setCatalog,
        sessionId,
        setSessionId,
        category,
        setCategory,
        query,
        setQuery,
        filesRef,
      }}
    >
      {children}
    </ArchiveContext.Provider>
  )
}

export function useSessionArchive(): ArchiveWorkspace {
  const workspace = useContext(ArchiveContext)
  if (!workspace) throw new Error('Session archive provider is missing.')
  return workspace
}
