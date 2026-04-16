import { useState, useRef, useEffect } from 'react'
import {
  apiAnalyzeSpec, apiGenerateOne, apiGetProjectWorkflows, apiImportProject,
  apiProjectRequest, apiIdentifyRequest, apiLogConversation, apiSuggestAnswer, apiListProjects
} from '../hooks/useWorkflow'
import { saveDraft, deleteDraft, listDrafts } from '../hooks/useDraft'

const STEPS = ['spec', 'map', 'workspace']

const PENDING_CATEGORIES = [
  {
    id: 'credentials',
    label: 'Credentials & API Keys',
    match: /api.?key|credential|password|secret|token|oauth|auth|private.?key|access.?key/i,
    placeholder: 'Paste your key or credential value here — this is only saved locally',
    noSuggest: true,
    bg: 'bg-orange-50', border: 'border-orange-200',
    headerBg: 'bg-orange-100', headerText: 'text-orange-700', dot: 'bg-orange-400'
  },
  {
    id: 'integrations',
    label: 'Integrations & Services',
    match: /webhook|endpoint|url|integration|service|connect|provider|platform|third.?party|app/i,
    placeholder: 'e.g. https://hooks.your-service.com/webhook/xxx',
    bg: 'bg-blue-50', border: 'border-blue-200',
    headerBg: 'bg-blue-100', headerText: 'text-blue-700', dot: 'bg-blue-400'
  },
  {
    id: 'data',
    label: 'Data & Schema',
    match: /field|schema|database|table|column|format|data.?model|structure|mapping|id|identifier/i,
    placeholder: 'e.g. user_id, email, phone_number',
    bg: 'bg-emerald-50', border: 'border-emerald-200',
    headerBg: 'bg-emerald-100', headerText: 'text-emerald-700', dot: 'bg-emerald-400'
  },
  {
    id: 'business',
    label: 'Business Logic & Rules',
    match: /when|how|should|rule|logic|process|flow|decide|policy|condition|trigger|behavior/i,
    placeholder: 'e.g. Send immediately after signup; retry up to 3 times on failure',
    bg: 'bg-violet-50', border: 'border-violet-200',
    headerBg: 'bg-violet-100', headerText: 'text-violet-700', dot: 'bg-violet-400'
  },
  {
    id: 'other',
    label: 'Other',
    match: null,
    placeholder: 'Add your answer or note here...',
    bg: 'bg-slate-50', border: 'border-slate-200',
    headerBg: 'bg-slate-100', headerText: 'text-slate-600', dot: 'bg-slate-400'
  }
]

function categorizePendingItem(itemText) {
  for (const cat of PENDING_CATEGORIES) {
    if (cat.match?.test(itemText)) return cat.id
  }
  return 'other'
}

export default function ProjectMode() {
  const [step, setStep] = useState('spec')
  const [spec, setSpec] = useState('')
  const [slug, setSlug] = useState('')
  const [workflowMap, setWorkflowMap] = useState(null)
  const [generated, setGenerated] = useState(null)    // { results: [...] }
  const [conversation, setConversation] = useState([]) // [{ at, request, updated }]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Clarification state (step: map)
  const [clarifications, setClarifications] = useState([])
  const [currentClarification, setCurrentClarification] = useState('')
  const [pendingInfo, setPendingInfo] = useState([])
  const [contextExpanded, setContextExpanded] = useState(false)
  const [optionalAnswers, setOptionalAnswers] = useState({})
  const clarificationRef = useRef(null)

  // Per-workflow generation progress (step: map, during generation)
  const [wfProgress, setWfProgress] = useState([])
  const abortRef = useRef(false)

  // Workspace: conversation log collapsed state
  const [logExpanded, setLogExpanded] = useState(false)

  // Pending info: per-category expand state + suggest loading
  const [categoryExpanded, setCategoryExpanded] = useState({})
  const [suggestingFor, setSuggestingFor] = useState(null)  // item text currently being suggested
  const requestBoxRef = useRef(null)

  // Workspace: change request
  const [requestText, setRequestText] = useState('')
  const [requestLoading, setRequestLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState([])   // names updated in last request
  const [requestProgress, setRequestProgress] = useState([])  // per-workflow progress during request
  const [requestQuestions, setRequestQuestions] = useState([]) // clarification questions from identify
  const [requestClarification, setRequestClarification] = useState('')
  const requestAbortRef = useRef(false)
  const requestClarRef = useRef(null)
  const errorRef = useRef(null)

  // Workspace: import
  const [importResults, setImportResults] = useState(null)
  const [importLoading, setImportLoading] = useState(false)

  // Project list
  const [drafts, setDrafts] = useState(() => listDrafts())
  const [serverProjects, setServerProjects] = useState([])

  // Save indicator
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [saveBtnFlash, setSaveBtnFlash] = useState(false)
  const [, setTick] = useState(0)
  const autoSaveTimer = useRef(null)

  // Load server projects on mount
  useEffect(() => {
    apiListProjects().then(setServerProjects).catch(() => {})
  }, [])

  // Tick every 30s to keep "X ago" label fresh
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // Auto-scroll to error when it appears
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [error])

  // Auto-scroll to clarification box when request questions appear
  useEffect(() => {
    if (requestQuestions.length > 0) {
      setTimeout(() => requestClarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
    }
  }, [requestQuestions])

  // When entering workspace, always load fresh data from server
  useEffect(() => {
    if (step !== 'workspace' || !slug) return
    apiGetProjectWorkflows(slug)
      .then(data => {
        setGenerated({ results: data.results })
        setConversation(data.conversation || [])
        if (data.spec && !spec) setSpec(data.spec)
        if (!workflowMap && data.manifest?.workflows?.length) {
          setWorkflowMap(reconstructWorkflowMap(data.manifest))
        }
      })
      .catch(() => {})
  }, [step, slug]) // eslint-disable-line react-hooks/exhaustive-deps

  // On resume in map step: rebuild wfProgress from manifest if empty
  useEffect(() => {
    if (!slug || step !== 'map' || wfProgress.length > 0 || !workflowMap) return
    fetch(`/api/projects/${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.manifest?.workflows?.length) return
        const doneNames = new Set(data.manifest.workflows.map(w => w.name))
        const ordered = [
          ...workflowMap.workflows.filter(w => w.role === 'sub'),
          ...workflowMap.workflows.filter(w => w.role === 'supervisor')
        ]
        const rebuilt = ordered.map(w => ({
          name: w.name, role: w.role,
          status: doneNames.has(w.name) ? 'done' : 'waiting'
        }))
        if (rebuilt.some(w => w.status === 'done')) setWfProgress(rebuilt)
      })
      .catch(() => {})
  }, [slug, step, workflowMap]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save on state changes (debounced 1s)
  useEffect(() => {
    if (!slug) return
    clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      saveDraft(slug, { step, spec, slug, clarifications, currentClarification, optionalAnswers, pendingInfo, workflowMap, wfProgress })
      setLastSavedAt(new Date())
    }, 1000)
    return () => clearTimeout(autoSaveTimer.current)
  }, [spec, slug, step, clarifications, currentClarification, optionalAnswers, pendingInfo, workflowMap, wfProgress])

  function handleSave() {
    if (!slug) return
    saveDraft(slug, { step, spec, slug, clarifications, currentClarification, optionalAnswers, pendingInfo, workflowMap, wfProgress })
    setLastSavedAt(new Date())
    setSaveBtnFlash(true)
    setTimeout(() => setSaveBtnFlash(false), 1500)
  }

  function refreshDrafts() { setDrafts(listDrafts()) }

  function relativeTime(isoStr) {
    const diff = Date.now() - new Date(isoStr)
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  function reconstructWorkflowMap(manifest) {
    return {
      projectName: manifest.name,
      workflows: manifest.workflows.map(w => ({
        name: w.name,
        role: w.role,
        purpose: w.purpose,
        trigger: w.trigger || (w.role === 'sub' ? 'sub-workflow' : 'webhook'),
        inputs: w.inputs || '',
        outputs: w.outputs || '',
        calls: w.calls || []
      }))
    }
  }

  const STEP_LABELS = { spec: 'Spec', map: 'Review map', workspace: 'Workspace' }

  function handleResume(draft) {
    setSpec(draft.spec || '')
    setSlug(draft.slug || '')
    // 'generate' and 'import' steps go to workspace now
    const resolvedStep = (draft.step === 'generate' || draft.step === 'import') ? 'workspace' : (draft.step || 'spec')
    setStep(resolvedStep)
    setClarifications(draft.clarifications || [])
    setCurrentClarification(draft.currentClarification || '')
    setOptionalAnswers(draft.optionalAnswers || {})
    setPendingInfo(draft.pendingInfo || [])
    setWorkflowMap(draft.workflowMap || null)
    setWfProgress(draft.wfProgress || [])
    setGenerated(null)       // workspace useEffect will reload from server
    setConversation([])
    setImportResults(null)
    setError(null)
    setLastUpdated([])
  }

  function handleDiscardDraft(slug) {
    deleteDraft(slug)
    refreshDrafts()
  }

  async function handleOpenProject(projectSlug) {
    setSlug(projectSlug)
    setSpec('')
    setWorkflowMap(null)
    setGenerated(null)
    setConversation([])
    setWfProgress([])
    setPendingInfo([])
    setClarifications([])
    setCurrentClarification('')
    setOptionalAnswers({})
    setImportResults(null)
    setError(null)
    setLastUpdated([])
    setLogExpanded(false)
    setStep('workspace')    // workspace useEffect handles the data load
  }

  function slugify(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  function applyMap(map) {
    setWorkflowMap(map)
    if (map.pendingInfo?.length) {
      setPendingInfo(prev => {
        const existing = new Set(prev.map(p => p.item))
        const newItems = map.pendingInfo
          .filter(item => !existing.has(item))
          .map(item => ({ item, note: '' }))
        return [...prev, ...newItems]
      })
    }
  }

  async function handleAnalyze() {
    if (!spec.trim() || !slug.trim()) return
    setLoading(true)
    setError(null)
    try {
      const map = await apiAnalyzeSpec(spec)
      applyMap(map)
      setStep('map')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleReanalyze() {
    const parts = []
    if (currentClarification.trim()) parts.push(currentClarification.trim())
    const answeredOptionals = nonBlockingGaps
      .filter(g => optionalAnswers[g.question]?.trim())
      .map(g => `${g.question}: ${optionalAnswers[g.question].trim()}`)
    if (answeredOptionals.length) parts.push('Optional answers:\n' + answeredOptionals.join('\n'))
    if (!parts.length) return

    const deferredOptionals = nonBlockingGaps
      .filter(g => !optionalAnswers[g.question]?.trim())
      .map(g => g.question)

    const combined = parts.join('\n\n')
    const newClarifications = [...clarifications, combined]
    setLoading(true)
    setError(null)
    try {
      const map = await apiAnalyzeSpec(spec, newClarifications.join('\n\n---\n'))
      setClarifications(newClarifications)
      setCurrentClarification('')
      setOptionalAnswers({})
      applyMap(map)
      if (deferredOptionals.length) {
        setPendingInfo(prev => {
          const existing = new Set(prev.map(p => p.item))
          const newItems = deferredOptionals
            .filter(item => !existing.has(item))
            .map(item => ({ item, note: '' }))
          return [...prev, ...newItems]
        })
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    const deferredOptionals = nonBlockingGaps
      .filter(g => !optionalAnswers[g.question]?.trim())
      .map(g => g.question)
    if (deferredOptionals.length) {
      setPendingInfo(prev => {
        const existing = new Set(prev.map(p => p.item))
        const newItems = deferredOptionals.filter(item => !existing.has(item)).map(item => ({ item, note: '' }))
        return [...prev, ...newItems]
      })
    }
    const ordered = [
      ...workflowMap.workflows.filter(w => w.role === 'sub'),
      ...workflowMap.workflows.filter(w => w.role === 'supervisor')
    ]
    const initialProgress = ordered.map(w => ({ name: w.name, role: w.role, status: 'waiting' }))
    setWfProgress(initialProgress)
    setLoading(true)
    setError(null)
    await runGeneration(initialProgress)
  }

  // ── Self-healing generation helpers ──────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  function classifyError(msg = '') {
    if (/401|403|unauthorized|invalid.api.key/i.test(msg)) return 'fatal'
    if (/credit.balance|too low|billing|purchase credits/i.test(msg)) return 'credit_exhausted'
    if (/429|rate.limit/i.test(msg)) return 'rate_limit'
    return 'retryable'
  }

  function setRowMsg(i, status, statusMsg) {
    setWfProgress(prev => prev.map((w, idx) =>
      idx === i ? { ...w, status, statusMsg } : w
    ))
  }

  async function runGeneration(progress) {
    const MAX_ATTEMPTS = 3
    abortRef.current = false
    const ordered = [
      ...workflowMap.workflows.filter(w => w.role === 'sub'),
      ...workflowMap.workflows.filter(w => w.role === 'supervisor')
    ]

    let fatalError = null
    let creditExhausted = false
    let anySkipped = false

    for (let i = 0; i < progress.length; i++) {
      if (abortRef.current) {
        setWfProgress(prev => prev.map(w =>
          w.status === 'generating' || w.status === 'waiting'
            ? { ...w, status: 'waiting', statusMsg: undefined } : w
        ))
        setLoading(false)
        return
      }

      if (progress[i].status === 'done') continue

      const wfSpec = ordered.find(w => w.name === progress[i].name)
      if (!wfSpec) continue

      setRowMsg(i, 'generating', undefined)
      let succeeded = false

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (abortRef.current) break
        try {
          await apiGenerateOne(slug, spec, workflowMap, wfSpec)
          succeeded = true
          break
        } catch (err) {
          const kind = classifyError(err.message)
          if (kind === 'fatal') {
            setRowMsg(i, 'error', 'Auth error — check API key')
            fatalError = err.message
            break
          }
          if (kind === 'credit_exhausted') {
            setRowMsg(i, 'error', 'Out of credits — continue when credits are available')
            creditExhausted = true
            break
          }
          if (attempt < MAX_ATTEMPTS) {
            if (kind === 'rate_limit') {
              setRowMsg(i, 'generating', `Rate limited — retrying in 30s (${attempt}/${MAX_ATTEMPTS})…`)
              await sleep(30000)
            } else {
              setRowMsg(i, 'generating', `Failed — retrying (${attempt}/${MAX_ATTEMPTS})…`)
              await sleep(3000)
            }
          } else {
            setRowMsg(i, 'error', kind === 'rate_limit'
              ? 'Skipped — rate limited after 3 attempts'
              : 'Skipped — timed out after 3 attempts')
            anySkipped = true
          }
        }
      }

      if (fatalError || creditExhausted) break
      if (succeeded) setRowMsg(i, 'done', undefined)
    }

    setLoading(false)

    if (fatalError) { setError(fatalError); return }
    if (creditExhausted) { setError('API credits exhausted. Add credits and click "Continue generating" when ready.'); return }
    if (anySkipped) { setError('Some workflows could not be generated. Click "Continue generating" to retry.'); return }

    // All done — go to workspace (server loads fresh data via useEffect)
    try {
      const data = await apiGetProjectWorkflows(slug)
      setGenerated({ results: data.results })
      setConversation(data.conversation || [])
      setWfProgress([])
      setStep('workspace')
    } catch (err) {
      setError(`Generation complete but failed to load results: ${err.message}`)
    }
  }

  async function handleContinueGenerate() {
    setLoading(true)
    setError(null)
    const resetProgress = wfProgress.map(w =>
      w.status === 'done' ? w : { ...w, status: 'waiting', statusMsg: undefined }
    )
    setWfProgress(resetProgress)
    await runGeneration(resetProgress)
  }

  // ── Workspace: change request ─────────────────────────────────────────────

  function setRequestRowMsg(i, status, statusMsg) {
    setRequestProgress(prev => prev.map((w, idx) =>
      idx === i ? { ...w, status, statusMsg } : w
    ))
  }

  async function handleProjectRequest() {
    const text = requestText.trim()
    if (!text) return
    setRequestLoading(true)
    setError(null)
    setRequestQuestions([])
    setRequestClarification('')
    setLastUpdated([])
    setRequestProgress([])

    try {
      // Step 1: identify affected workflows + surface any blocking questions
      const { workflows: toUpdate, questions } = await apiIdentifyRequest(slug, text)

      if (questions.length > 0) {
        // Needs clarification before proceeding — show gate
        setRequestQuestions(questions)
        setRequestLoading(false)
        return
      }

      await runRequestGeneration(text, toUpdate)
    } catch (err) {
      setError(err.message)
      setRequestLoading(false)
    }
  }

  async function handleSubmitWithClarification() {
    if (!requestClarification.trim()) return
    const combinedText = `${requestText}\n\nAdditional context: ${requestClarification}`
    setRequestLoading(true)
    setError(null)
    setRequestQuestions([])
    setRequestProgress([])

    try {
      const { workflows: toUpdate, questions } = await apiIdentifyRequest(slug, combinedText)
      if (questions.length > 0) {
        setRequestQuestions(questions)
        setRequestLoading(false)
        return
      }
      await runRequestGeneration(combinedText, toUpdate)
    } catch (err) {
      setError(err.message)
      setRequestLoading(false)
    }
  }

  async function runRequestGeneration(feedbackText, toUpdate) {
    const MAX_ATTEMPTS = 3
    requestAbortRef.current = false

    // Build ordered progress rows (subs first, supervisor last), only identified workflows
    const allOrdered = [
      ...(workflowMap?.workflows || []).filter(w => w.role === 'sub'),
      ...(workflowMap?.workflows || []).filter(w => w.role === 'supervisor')
    ]
    const ordered = allOrdered.filter(w => toUpdate.includes(w.name))
    const initialProgress = ordered.map(w => ({ name: w.name, role: w.role, status: 'waiting' }))
    setRequestProgress(initialProgress)

    let fatalError = null
    let creditExhausted = false
    let anySkipped = false
    const succeeded = []

    for (let i = 0; i < ordered.length; i++) {
      if (requestAbortRef.current) {
        setRequestProgress(prev => prev.map(w =>
          w.status !== 'done' ? { ...w, status: 'waiting', statusMsg: undefined } : w
        ))
        setRequestLoading(false)
        return
      }

      const wfSpec = ordered[i]
      setRequestRowMsg(i, 'generating', undefined)
      let ok = false

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (requestAbortRef.current) break
        try {
          await apiGenerateOne(slug, spec, workflowMap, wfSpec, feedbackText)
          ok = true
          break
        } catch (err) {
          const kind = classifyError(err.message)
          if (kind === 'fatal') {
            setRequestRowMsg(i, 'error', 'Auth error — check API key')
            fatalError = err.message
            break
          }
          if (kind === 'credit_exhausted') {
            setRequestRowMsg(i, 'error', 'Out of credits')
            creditExhausted = true
            break
          }
          if (attempt < MAX_ATTEMPTS) {
            if (kind === 'rate_limit') {
              setRequestRowMsg(i, 'generating', `Rate limited — retrying in 30s (${attempt}/${MAX_ATTEMPTS})…`)
              await sleep(30000)
            } else {
              setRequestRowMsg(i, 'generating', `Failed — retrying (${attempt}/${MAX_ATTEMPTS})…`)
              await sleep(3000)
            }
          } else {
            setRequestRowMsg(i, 'error', kind === 'rate_limit'
              ? 'Skipped — rate limited after 3 attempts'
              : 'Skipped — timed out after 3 attempts')
            anySkipped = true
          }
        }
      }

      if (fatalError || creditExhausted) break
      if (ok) { setRequestRowMsg(i, 'done', undefined); succeeded.push(wfSpec.name) }
    }

    if (fatalError) { setError(fatalError); setRequestLoading(false); return }
    if (creditExhausted) { setError('API credits exhausted. Add credits and try again.'); setRequestLoading(false); return }

    // Log to conversation and reload workspace
    try {
      const logData = await apiLogConversation(slug, requestText, toUpdate)
      setConversation(logData.conversation)
    } catch { /* non-critical */ }

    try {
      const data = await apiGetProjectWorkflows(slug)
      setGenerated({ results: data.results })
      setConversation(data.conversation || [])
    } catch { /* keep existing */ }

    setLastUpdated(succeeded)
    setRequestText('')
    setRequestClarification('')
    setRequestLoading(false)

    if (anySkipped) {
      setError('Some workflows could not be updated. You can submit the request again to retry.')
    }
  }

  // ── Pending info helpers ──────────────────────────────────────────────────

  async function handleSuggestAnswer(itemText) {
    setSuggestingFor(itemText)
    try {
      const suggestion = await apiSuggestAnswer(slug, itemText)
      setPendingInfo(prev => prev.map(p =>
        p.item === itemText ? { ...p, note: suggestion } : p
      ))
    } catch (err) {
      setError(`Could not generate suggestion: ${err.message}`)
    } finally {
      setSuggestingFor(null)
    }
  }

  function handleApplyPendingNotes(uniquePending) {
    const filled = uniquePending.filter(p => p.note?.trim())
    if (!filled.length) return
    const lines = filled.map(p => `• ${p.item}: ${p.note.trim()}`)
    const text = `I've provided the following configuration details:\n\n${lines.join('\n')}\n\nPlease update the workflows to use these values where applicable.`
    setRequestText(text)
    setTimeout(() => requestBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  // ── Workspace: import ─────────────────────────────────────────────────────

  async function handleImport() {
    if (!generated?.results) return
    setImportLoading(true)
    setError(null)
    try {
      const workflows = generated.results.map(r => ({
        name: r.spec.name,
        role: r.spec.role,
        workflow: r.workflow
      }))
      const data = await apiImportProject(slug, workflows)
      setImportResults(data)
      deleteDraft(slug)
      refreshDrafts()
      // Refresh server projects list
      apiListProjects().then(setServerProjects).catch(() => {})
    } catch (err) {
      setError(err.message)
    } finally {
      setImportLoading(false)
    }
  }

  function handleDownload(workflow, name) {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleReset() {
    if (slug) { deleteDraft(slug); refreshDrafts() }
    setStep('spec'); setSpec(''); setSlug(''); setWorkflowMap(null)
    setGenerated(null); setConversation([]); setImportResults(null); setError(null)
    setClarifications([]); setCurrentClarification(''); setPendingInfo([])
    setContextExpanded(false); setOptionalAnswers({}); setWfProgress([])
    setRequestText(''); setLastUpdated([]); setRequestProgress([])
    setRequestQuestions([]); setRequestClarification(''); setLogExpanded(false)
    setCategoryExpanded({}); setSuggestingFor(null)
    apiListProjects().then(setServerProjects).catch(() => {})
  }

  const blockingGaps = workflowMap?.gaps?.filter(g => g.blocking) ?? []
  const nonBlockingGaps = workflowMap?.gaps?.filter(g => !g.blocking) ?? []
  const canGenerate = blockingGaps.length === 0

  // Server projects that don't have a local draft (avoid duplication in list)
  const draftSlugs = new Set(drafts.map(d => d.slug))
  const serverOnlyProjects = serverProjects.filter(p => !draftSlugs.has(p.slug))

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          {[
            { id: 'spec', label: '1. Spec' },
            { id: 'map', label: '2. Review map' },
            { id: 'workspace', label: '3. Workspace' }
          ].map((s, i) => {
            const idx = STEPS.indexOf(step)
            const done = STEPS.indexOf(s.id) < idx
            const active = s.id === step
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className={`text-xs font-semibold px-2 py-1 rounded ${
                  active ? 'bg-indigo-600 text-white' :
                  done ? 'bg-green-100 text-green-700' :
                  'bg-slate-100 text-slate-400'
                }`}>{s.label}</span>
                {i < 2 && <span className="text-slate-300">→</span>}
              </div>
            )
          })}
        </div>
        {slug && step !== 'spec' && (
          <div className="flex items-center gap-2">
            <span className={`text-xs ${lastSavedAt ? 'text-slate-400' : 'text-amber-500'}`}>
              {lastSavedAt ? `Saved ${relativeTime(lastSavedAt)}` : 'Unsaved'}
            </span>
            <button
              onClick={handleSave}
              className={`text-xs border px-2 py-1 rounded transition-colors ${
                saveBtnFlash
                  ? 'border-green-300 text-green-600'
                  : 'border-slate-200 text-slate-500 hover:border-indigo-400 hover:text-indigo-600'
              }`}
            >
              {saveBtnFlash ? 'Saved ✓' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div ref={errorRef} className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* ── Step 1: Spec ─────────────────────────────────────────────────── */}
      {step === 'spec' && (
        <div>
          {/* Saved drafts + server projects */}
          {(drafts.length > 0 || serverOnlyProjects.length > 0) && (
            <div className="mb-6">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Your projects</div>
              <div className="space-y-2">
                {drafts.map(draft => (
                  <div key={draft.slug} className="flex items-center gap-3 border border-slate-200 rounded-lg px-4 py-3 bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-slate-800 truncate">{draft.slug}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                          draft.step === 'workspace' || draft.step === 'import' || draft.step === 'generate'
                            ? 'bg-green-100 text-green-700' :
                          draft.step === 'map' ? 'bg-indigo-100 text-indigo-700' :
                          'bg-slate-200 text-slate-600'
                        }`}>{STEP_LABELS[draft.step] || draft.step}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">Saved {relativeTime(draft.savedAt)}</div>
                    </div>
                    <button
                      onClick={() => handleResume(draft)}
                      className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-indigo-700 transition-colors shrink-0"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => handleDiscardDraft(draft.slug)}
                      className="text-xs text-slate-400 hover:text-red-500 px-2 py-1.5 rounded font-semibold transition-colors shrink-0"
                    >
                      Discard
                    </button>
                  </div>
                ))}
                {serverOnlyProjects.map(p => (
                  <div key={p.slug} className="flex items-center gap-3 border border-slate-200 rounded-lg px-4 py-3 bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-slate-800 truncate">{p.slug}</span>
                        <span className="text-xs text-slate-400">{p.workflowCount} workflow{p.workflowCount !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">{p.name !== p.slug ? p.name : ''}</div>
                    </div>
                    <button
                      onClick={() => handleOpenProject(p.slug)}
                      className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-indigo-700 transition-colors shrink-0"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">or start a new project</span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Project slug</label>
            <input
              className="w-full border-2 border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              placeholder="e.g. customer-onboarding"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              onBlur={e => setSlug(slugify(e.target.value))}
            />
            <p className="text-xs text-slate-400 mt-1">Used for the project folder name. Lowercase, hyphens only.</p>
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Project spec</label>
            <textarea
              className="w-full border-2 border-slate-200 rounded-xl p-4 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400 font-mono"
              rows={14}
              placeholder="Paste your project spec here..."
              value={spec}
              onChange={e => setSpec(e.target.value)}
            />
          </div>
          <button
            onClick={handleAnalyze}
            disabled={loading || !spec.trim() || !slug.trim()}
            className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Analyzing...' : 'Analyze spec →'}
          </button>
        </div>
      )}

      {/* ── Step 2: Review map ───────────────────────────────────────────── */}
      {step === 'map' && workflowMap && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-1">Proposed workflow system</h3>
          <p className="text-xs text-slate-400 mb-4">Review before generating. Claude will build each workflow with awareness of the others.</p>

          <div className="space-y-3 mb-4">
            {workflowMap.workflows?.map((wf, i) => (
              <div key={i} className={`border rounded-xl p-4 ${wf.role === 'supervisor' ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${wf.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {wf.role}
                  </span>
                  <span className="font-semibold text-sm text-slate-800">{wf.name}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2">{wf.purpose}</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <div><span className="font-semibold">Trigger:</span> {wf.trigger}</div>
                  <div><span className="font-semibold">Inputs:</span> {wf.inputs}</div>
                  <div className="col-span-2"><span className="font-semibold">Outputs:</span> {wf.outputs}</div>
                  {wf.calls?.length > 0 && (
                    <div className="col-span-2"><span className="font-semibold">Calls:</span> {wf.calls.join(', ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Blocking gaps */}
          {blockingGaps.length > 0 && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg overflow-hidden">
              <div className="px-4 pt-3 pb-2">
                <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">Required — answer before generating</div>
                <ul className="text-sm text-red-700 space-y-1 mb-3">
                  {blockingGaps.map((g, i) => <li key={i}>• {g.question}</li>)}
                </ul>
              </div>
              <div className="px-4 pb-4">
                <textarea
                  ref={clarificationRef}
                  className="w-full border-2 border-red-200 rounded-lg p-3 text-sm leading-relaxed resize-none focus:outline-none focus:border-red-400 bg-white"
                  rows={3}
                  placeholder="Answer the required questions above..."
                  value={currentClarification}
                  onChange={e => setCurrentClarification(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Non-blocking gaps */}
          {nonBlockingGaps.length > 0 && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg overflow-hidden">
              <div className="px-4 pt-3 pb-1">
                <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-0.5">Optional — answer or leave blank to defer</div>
                <p className="text-xs text-amber-600 mb-3">Blank fields are saved to pending info for later.</p>
              </div>
              <div className="px-4 pb-4 space-y-3">
                {nonBlockingGaps.map((g, i) => (
                  <div key={i}>
                    <label className="block text-xs text-amber-800 font-medium mb-1">• {g.question}</label>
                    <input
                      className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-amber-400"
                      placeholder="Leave blank to defer..."
                      value={optionalAnswers[g.question] || ''}
                      onChange={e => setOptionalAnswers(prev => ({ ...prev, [g.question]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No gaps — free-form clarification */}
          {blockingGaps.length === 0 && nonBlockingGaps.length === 0 && (
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Add clarifications (optional)</label>
              <textarea
                ref={clarificationRef}
                className="w-full border-2 border-slate-200 rounded-xl p-3 text-sm leading-relaxed resize-none focus:outline-none focus:border-indigo-400"
                rows={3}
                placeholder="Any additional context or changes to the workflow structure..."
                value={currentClarification}
                onChange={e => setCurrentClarification(e.target.value)}
              />
            </div>
          )}

          {/* Re-analyze */}
          <div className="mb-4">
            <button
              onClick={handleReanalyze}
              disabled={loading || (!currentClarification.trim() && !nonBlockingGaps.some(g => optionalAnswers[g.question]?.trim()))}
              className="bg-slate-700 text-white px-5 py-2 rounded-lg font-semibold text-sm hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading && !wfProgress.length ? 'Re-analyzing...' : 'Re-analyze →'}
            </button>
          </div>

          {/* Context so far */}
          {clarifications.length > 0 && (
            <div className="mb-4 border border-slate-200 rounded-lg overflow-hidden">
              <button
                onClick={() => setContextExpanded(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100"
              >
                <span>Context added so far ({clarifications.length} round{clarifications.length !== 1 ? 's' : ''})</span>
                <span>{contextExpanded ? '▲' : '▼'}</span>
              </button>
              {contextExpanded && (
                <div className="px-3 py-2 space-y-2">
                  {clarifications.map((c, i) => (
                    <div key={i} className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2">
                      <div className="font-semibold text-slate-400 mb-0.5">Round {i + 1}</div>
                      <div className="whitespace-pre-wrap">{c}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pending info */}
          {pendingInfo.length > 0 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Pending info (to provide later)</div>
              <div className="space-y-2">
                {pendingInfo.map((p, i) => (
                  <div key={i}>
                    <div className="text-sm text-amber-800">• {p.item}</div>
                    <input
                      className="mt-1 w-full border border-amber-200 rounded px-2 py-1 text-xs text-slate-600 bg-white focus:outline-none focus:border-amber-400"
                      placeholder="Your note (optional)..."
                      value={p.note}
                      onChange={e => setPendingInfo(prev => prev.map((item, idx) => idx === i ? { ...item, note: e.target.value } : item))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Generation progress */}
          {wfProgress.length > 0 && (
            <div className="mb-4 border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Generating {wfProgress.length} workflow{wfProgress.length !== 1 ? 's' : ''}
              </div>
              <div className="divide-y divide-slate-100">
                {wfProgress.map((w, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center text-base leading-none">
                      {w.status === 'done' ? '✅' : w.status === 'generating' ? '⏳' : w.status === 'error' ? '✗' : '○'}
                    </span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase shrink-0 ${w.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {w.role}
                    </span>
                    <span className="text-sm text-slate-700 flex-1">{w.name}</span>
                    <span className={`text-xs shrink-0 max-w-xs text-right ${
                      w.status === 'done' ? 'text-green-600' :
                      w.status === 'generating' ? 'text-indigo-500 animate-pulse' :
                      w.status === 'error' ? 'text-red-500' : 'text-slate-300'
                    }`}>
                      {w.statusMsg || (w.status === 'done' ? 'done' : w.status === 'generating' ? 'generating...' : w.status === 'error' ? 'failed' : 'waiting')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action bar */}
          {(() => {
            const hasPartialProgress = wfProgress.length > 0 && wfProgress.some(w => w.status === 'done')
            const hasFailed = wfProgress.some(w => w.status === 'error')
            const showContinue = !loading && hasPartialProgress && (hasFailed || wfProgress.some(w => w.status === 'waiting'))
            return (
              <div className="flex gap-3 flex-wrap">
                {!loading && showContinue && (
                  <button onClick={handleContinueGenerate} className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 transition-colors">
                    Continue generating →
                  </button>
                )}
                {!loading && !showContinue && (
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    title={!canGenerate ? 'Answer the required questions above before generating' : ''}
                    className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {`Generate ${workflowMap.workflows?.length} workflows →`}
                  </button>
                )}
                {loading && (
                  <>
                    <button disabled className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold text-sm opacity-50 cursor-not-allowed">
                      Generating…
                    </button>
                    <button
                      onClick={() => { abortRef.current = true }}
                      className="bg-white text-red-500 border border-red-200 px-4 py-3 rounded-lg text-sm font-semibold hover:bg-red-50 hover:border-red-300 transition-colors"
                    >
                      Stop
                    </button>
                  </>
                )}
                {!loading && (
                  <button onClick={() => setStep('spec')} className="bg-white text-slate-400 border border-slate-200 px-4 py-3 rounded-lg text-sm hover:border-slate-300">
                    ← Back to spec
                  </button>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── Step 3: Workspace ────────────────────────────────────────────── */}
      {step === 'workspace' && (
        <div>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-slate-700">{workflowMap?.projectName || slug}</h3>
              <p className="text-xs text-slate-400">
                {generated?.results?.length
                  ? `${generated.results.length} workflow${generated.results.length !== 1 ? 's' : ''} · ${generated.results.filter(r => r.validation?.valid).length} valid`
                  : 'Loading workflows…'}
              </p>
            </div>
          </div>

          {/* Workflow cards */}
          {generated?.results?.length > 0 ? (
            <div className="space-y-2 mb-6">
              {generated.results.map((item, i) => {
                const wasJustUpdated = lastUpdated.includes(item.spec.name)
                return (
                  <div key={i} className={`border rounded-xl p-4 transition-colors ${
                    wasJustUpdated ? 'border-indigo-300 bg-indigo-50' :
                    item.spec.role === 'supervisor' ? 'border-slate-300 bg-white' : 'border-slate-200 bg-white'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase shrink-0 ${item.spec.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                          {item.spec.role}
                        </span>
                        <span className="font-semibold text-sm text-slate-800 truncate">{item.spec.name}</span>
                        <span className={`text-xs shrink-0 ${item.validation?.valid ? 'text-green-500' : 'text-amber-500'}`}>
                          {item.validation?.valid ? '● ready' : '● needs review'}
                        </span>
                        {wasJustUpdated && (
                          <span className="text-xs text-indigo-600 font-semibold shrink-0">updated</span>
                        )}
                      </div>
                      <button
                        onClick={() => handleDownload(item.workflow, item.spec.name)}
                        className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200 shrink-0 ml-2"
                      >
                        Download
                      </button>
                    </div>
                    {item.summary && (
                      <p className="text-xs text-slate-500 mt-1.5">{item.summary}</p>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-400">
              Loading project workflows…
            </div>
          )}

          {/* Import results (shown inline after importing) */}
          {importResults && (
            <div className="mb-6 border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-green-50 border-b border-slate-200 text-xs font-semibold text-green-700 uppercase tracking-wide">
                Imported to n8n
              </div>
              <div className="divide-y divide-slate-100">
                {importResults.results?.map((r, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${r.success ? 'text-green-500' : 'text-red-500'}`}>
                        {r.success ? '●' : '●'}
                      </span>
                      <span className="text-sm text-slate-700">{r.name}</span>
                      {r.n8nId && <span className="text-xs text-slate-400">ID: {r.n8nId}</span>}
                    </div>
                    {r.success && r.workflowUrl && (
                      <a href={r.workflowUrl} target="_blank" rel="noreferrer"
                        className="text-xs bg-indigo-600 text-white px-3 py-1 rounded font-semibold hover:bg-indigo-700">
                        Open in n8n
                      </a>
                    )}
                    {!r.success && <span className="text-xs text-red-500">{r.error}</span>}
                  </div>
                ))}
              </div>
              {importResults.results?.some(r => r.success) && (
                <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
                  Next: open each sub-workflow in n8n, copy its ID from the URL, then update the Execute Sub-workflow nodes in the supervisor with the correct IDs.
                </div>
              )}
            </div>
          )}

          {/* Pending info — categorised, deduplicated, progress bar, suggest button */}
          {pendingInfo.length > 0 && (() => {
            // Deduplicate by normalised item text
            const seen = new Set()
            const unique = pendingInfo.filter(p => {
              const key = p.item.toLowerCase().trim()
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
            const answeredCount = unique.filter(p => p.note?.trim()).length
            const totalCount = unique.length
            const allDone = answeredCount === totalCount

            // Group into categories
            const grouped = {}
            for (const cat of PENDING_CATEGORIES) grouped[cat.id] = []
            for (const p of unique) grouped[categorizePendingItem(p.item)].push(p)
            const active = PENDING_CATEGORIES.filter(cat => grouped[cat.id].length > 0)

            return (
              <div className="mb-6">
                {/* Section header + progress */}
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Things still to configure</div>
                  <span className={`text-xs font-semibold ${allDone ? 'text-green-600' : 'text-slate-400'}`}>
                    {answeredCount} / {totalCount} answered
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 bg-slate-100 rounded-full mb-4 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${allDone ? 'bg-green-500' : 'bg-indigo-500'}`}
                    style={{ width: `${totalCount > 0 ? (answeredCount / totalCount) * 100 : 0}%` }}
                  />
                </div>

                {/* Category cards */}
                <div className="space-y-3">
                  {active.map(cat => {
                    const items = grouped[cat.id]
                    const catDone = items.every(p => p.note?.trim())
                    // Expand by default unless all items in this category are filled
                    const isExpanded = categoryExpanded[cat.id] !== undefined
                      ? categoryExpanded[cat.id]
                      : !catDone

                    return (
                      <div key={cat.id} className={`border ${cat.border} rounded-xl overflow-hidden`}>
                        {/* Category header — clickable to toggle */}
                        <button
                          onClick={() => setCategoryExpanded(prev => ({ ...prev, [cat.id]: !isExpanded }))}
                          className={`w-full flex items-center justify-between px-4 py-2.5 ${catDone ? 'bg-green-50' : cat.headerBg} transition-colors`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`inline-block w-2 h-2 rounded-full ${catDone ? 'bg-green-500' : cat.dot}`} />
                            <span className={`text-xs font-semibold ${catDone ? 'text-green-700' : cat.headerText} uppercase tracking-wide`}>
                              {cat.label}
                            </span>
                            {catDone && <span className="text-xs text-green-600 font-bold">✓ All done</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400">
                              {items.filter(p => p.note?.trim()).length}/{items.length}
                            </span>
                            <span className="text-slate-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                          </div>
                        </button>

                        {/* Items */}
                        {isExpanded && (
                          <div className={`${cat.bg} divide-y ${cat.border}`}>
                            {items.map((p, i) => {
                              const isSuggesting = suggestingFor === p.item
                              return (
                                <div key={i} className="px-4 py-3">
                                  <div className="flex items-start gap-2 mb-2">
                                    <p className="text-sm text-slate-700 flex-1">{p.item}</p>
                                    {p.note?.trim() && (
                                      <span className="shrink-0 w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold leading-none mt-0.5">✓</span>
                                    )}
                                  </div>
                                  <textarea
                                    className={`w-full border ${cat.border} rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none leading-relaxed`}
                                    rows={2}
                                    placeholder={cat.placeholder}
                                    value={p.note || ''}
                                    onChange={e => setPendingInfo(prev => prev.map(item =>
                                      item.item === p.item ? { ...item, note: e.target.value } : item
                                    ))}
                                  />
                                  {!cat.noSuggest && (
                                    <button
                                      onClick={() => handleSuggestAnswer(p.item)}
                                      disabled={isSuggesting}
                                      className="mt-1.5 text-xs text-indigo-500 hover:text-indigo-700 disabled:text-slate-400 flex items-center gap-1 transition-colors"
                                    >
                                      {isSuggesting
                                        ? <><span className="animate-pulse">✦</span> Thinking…</>
                                        : <><span>✦</span> Help me think of an answer</>
                                      }
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Apply CTA */}
                {answeredCount > 0 && (
                  <button
                    onClick={() => handleApplyPendingNotes(unique)}
                    className="mt-4 w-full bg-indigo-600 text-white py-2.5 rounded-xl font-semibold text-sm hover:bg-indigo-700 transition-colors"
                  >
                    Apply answers to my workflows →
                  </button>
                )}
              </div>
            )
          })()}

          {/* Conversation log — collapsed by default */}
          {conversation.length > 0 && (
            <div className="mb-4 border border-slate-200 rounded-lg overflow-hidden">
              <button
                onClick={() => setLogExpanded(v => !v)}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide transition-colors"
              >
                <span>Previous requests ({conversation.length})</span>
                <span className="text-slate-400">{logExpanded ? '▲' : '▼'}</span>
              </button>
              {logExpanded && (
                <div className="divide-y divide-slate-100">
                  {conversation.map((entry, i) => (
                    <div key={i} className="px-4 py-2.5 text-xs text-slate-500">
                      <span className="text-slate-400 mr-2">{relativeTime(entry.at)}</span>
                      <span className="text-slate-700">"{entry.request}"</span>
                      <span className="text-slate-400"> → updated {entry.updated.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Request box */}
          <div ref={requestBoxRef} className="mb-4 border-2 border-slate-200 rounded-xl p-4 focus-within:border-indigo-300 transition-colors">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              What would you like to add or change?
            </label>
            <textarea
              className="w-full text-sm leading-relaxed resize-none focus:outline-none bg-transparent"
              rows={4}
              placeholder="Describe what you'd like to change in your own words — e.g. 'add a welcome message with the user's name', 'the session check should happen before loading data', 'add error handling for failed API calls'..."
              value={requestText}
              onChange={e => setRequestText(e.target.value)}
              disabled={requestLoading}
            />
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <button
                onClick={handleProjectRequest}
                disabled={requestLoading || !requestText.trim() || !generated?.results?.length || requestQuestions.length > 0}
                className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {requestLoading && !requestProgress.length ? 'Checking request…' : 'Submit request →'}
              </button>
              {requestLoading && requestProgress.length > 0 && (
                <button
                  onClick={() => { requestAbortRef.current = true }}
                  className="bg-white text-red-500 border border-red-200 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-50 hover:border-red-300 transition-colors"
                >
                  Stop
                </button>
              )}
              {lastUpdated.length > 0 && !requestLoading && (
                <span className="text-xs text-green-600 font-semibold">
                  Updated: {lastUpdated.join(', ')}
                </span>
              )}
            </div>
          </div>

          {/* Clarification gate — shown when request needs more info */}
          {requestQuestions.length > 0 && (
            <div ref={requestClarRef} className="mb-4 border-2 border-amber-300 rounded-xl overflow-hidden">
              <div className="px-4 pt-3 pb-2 bg-amber-50">
                <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">
                  A couple of things to clarify first
                </div>
                <ul className="text-sm text-amber-800 space-y-1 mb-3">
                  {requestQuestions.map((q, i) => (
                    <li key={i} className="flex gap-2"><span className="text-amber-500 shrink-0">{i + 1}.</span>{q}</li>
                  ))}
                </ul>
                <textarea
                  className="w-full border border-amber-200 rounded-lg p-3 text-sm leading-relaxed resize-none focus:outline-none focus:border-amber-400 bg-white"
                  rows={3}
                  placeholder="Answer the questions above in your own words..."
                  value={requestClarification}
                  onChange={e => setRequestClarification(e.target.value)}
                />
              </div>
              <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 flex gap-3">
                <button
                  onClick={handleSubmitWithClarification}
                  disabled={requestLoading || !requestClarification.trim()}
                  className="bg-amber-600 text-white px-5 py-2 rounded-lg font-semibold text-sm hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {requestLoading ? 'Updating…' : 'Update workflows →'}
                </button>
                <button
                  onClick={() => { setRequestQuestions([]); setRequestClarification('') }}
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Per-workflow progress during request */}
          {requestProgress.length > 0 && (
            <div className="mb-4 border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Updating {requestProgress.length} workflow{requestProgress.length !== 1 ? 's' : ''}
              </div>
              <div className="divide-y divide-slate-100">
                {requestProgress.map((w, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center text-base leading-none">
                      {w.status === 'done' ? '✅' : w.status === 'generating' ? '⏳' : w.status === 'error' ? '✗' : '○'}
                    </span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase shrink-0 ${w.role === 'supervisor' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                      {w.role}
                    </span>
                    <span className="text-sm text-slate-700 flex-1">{w.name}</span>
                    <span className={`text-xs shrink-0 max-w-xs text-right ${
                      w.status === 'done' ? 'text-green-600' :
                      w.status === 'generating' ? 'text-indigo-500 animate-pulse' :
                      w.status === 'error' ? 'text-red-500' : 'text-slate-300'
                    }`}>
                      {w.statusMsg || (
                        w.status === 'done' ? 'done' :
                        w.status === 'generating' ? 'updating...' :
                        w.status === 'error' ? 'failed' : 'waiting'
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom actions */}
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleImport}
              disabled={importLoading || !generated?.results?.length || requestLoading}
              className="bg-slate-800 text-white px-6 py-2.5 rounded-lg font-semibold text-sm hover:bg-slate-900 disabled:opacity-50 transition-colors"
            >
              {importLoading ? 'Importing…' : 'Import all to n8n'}
            </button>
            <button
              onClick={() => generated?.results?.forEach(r => handleDownload(r.workflow, r.spec.name))}
              disabled={!generated?.results?.length}
              className="bg-white text-slate-600 border border-slate-200 px-5 py-2.5 rounded-lg text-sm font-semibold hover:border-slate-300 disabled:opacity-50"
            >
              Download all
            </button>
            <button
              onClick={handleReset}
              className="bg-white text-slate-400 border border-slate-200 px-4 py-2.5 rounded-lg text-sm hover:border-slate-300"
            >
              New project
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
