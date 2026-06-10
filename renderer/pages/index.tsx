import { useEffect } from 'react'
import { useRouter } from 'next/router'

// Electron loads /dashboard directly; this redirect just makes the bare "/"
// route resolve (e.g. if someone opens the dev URL in a browser) instead of 404.
export default function IndexPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/dashboard')
  }, [router])
  return null
}
