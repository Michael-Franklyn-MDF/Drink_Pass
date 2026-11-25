import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
const supabase = url && publishableKey ? createClient(url, publishableKey) : null

export default function App() {
  const [instruments, setInstruments] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!supabase) return

    const controller = new AbortController()

    async function loadInstruments() {
      const { data, error } = await supabase
        .from('instruments')
        .select('id, name')
        .order('id')
        .abortSignal(controller.signal)

      if (controller.signal.aborted) return
      if (error) {
        setError(true)
      } else {
        setInstruments(data)
      }
    }

    void loadInstruments()
    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>Instruments</h1>
      {!supabase && <p>Add your Supabase URL and publishable key to <code>.env.local</code>, then restart Vite.</p>}
      {supabase && !error && instruments === null && <p role="status">Loading instruments…</p>}
      {error && <p role="alert">Couldn’t load instruments. Check your Supabase settings and reload.</p>}
      {instruments?.length === 0 && <p>No instruments found.</p>}
      {instruments?.length > 0 && (
        <ul>
          {instruments.map(({ id, name }) => <li key={id}>{name}</li>)}
        </ul>
      )}
    </main>
  )
}
