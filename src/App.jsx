import { useEffect, useMemo, useState } from 'react'
import { initializeApp } from 'firebase/app'
import {
  doc,
  getFirestore,
  onSnapshot,
  runTransaction,
} from 'firebase/firestore'
import './App.css'

const CSV_FILE = '/Provisional_drug_overdose_death_counts_for_specific_drugs.csv'

const firebaseConfig = {
  apiKey: 'AIzaSyDp4AiCY1csq6Nh9FKhWWB0Zj9T0IDnBNw',
  authDomain: 'soshprojectdrugs.firebaseapp.com',
  projectId: 'soshprojectdrugs',
  storageBucket: 'soshprojectdrugs.firebasestorage.app',
  messagingSenderId: '403239203012',
  appId: '1:403239203012:web:68d9c921103f5fc0bb9991',
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)
const voteDocRef = doc(db, 'votes', 'main')

function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n')
  if (!header) return []

  return rows
    .map((line) => line.split(','))
    .filter((cols) => cols.length >= 8)
    .map((cols) => {
      const [
        dataAsOf,
        deathYear,
        deathMonth,
        jurisdiction,
        drugInvolved,
        timePeriod,
        monthEndingDate,
        overdoseDeaths,
      ] = cols

      const monthNumber = String(deathMonth).padStart(2, '0')
      const monthLabel = `${deathYear}-${monthNumber}`

      return {
        dataAsOf,
        deathYear: Number(deathYear),
        deathMonth: Number(deathMonth),
        jurisdiction,
        drugInvolved,
        timePeriod,
        monthEndingDate,
        monthLabel,
        overdoseDeaths: Number(overdoseDeaths),
        dateKey: new Date(monthEndingDate),
      }
    })
}

function App() {
  const [rawData, setRawData] = useState([])
  const [selectedDrugs, setSelectedDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [voteCounts, setVoteCounts] = useState({ support: 0, burn: 0 })
  const [voteLoading, setVoteLoading] = useState(false)
  const [voteError, setVoteError] = useState('')
  const [hasVotedBurn, setHasVotedBurn] = useState(false)
  const [voteMood, setVoteMood] = useState('neutral')
  const [showBurnLock, setShowBurnLock] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const response = await fetch(CSV_FILE)
        if (!response.ok) throw new Error('Failed to fetch data')
        const text = await response.text()
        const parsed = parseCsv(text)
        setRawData(parsed)
        const uniqueDrugs = Array.from(
          new Set(parsed.map((row) => row.drugInvolved)),
        ).sort()
        setSelectedDrugs(uniqueDrugs.slice(0, 3))
      } catch (err) {
        setError(err.message || 'Unable to load data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [])

  useEffect(() => {
    const storedBurnFlag = localStorage.getItem('sosh-voted-burn')
    const storedMood = localStorage.getItem('sosh-vote-mood')
    if (storedBurnFlag === 'true') setHasVotedBurn(true)
    if (storedMood === 'support' || storedMood === 'burn') setVoteMood(storedMood)

    const unsubscribe = onSnapshot(
      voteDocRef,
      (snapshot) => {
        const data = snapshot.data()
        if (data) {
          setVoteCounts({
            support: data.support || 0,
            burn: data.burn || 0,
          })
        }
      },
      (err) => {
        setVoteError(err.message || 'Unable to load votes')
      },
    )

    return () => unsubscribe()
  }, [])

  const availableDrugs = useMemo(
    () =>
      Array.from(new Set(rawData.map((row) => row.drugInvolved))).sort(
        (a, b) => a.localeCompare(b),
      ),
    [rawData],
  )

  const monthlyData = useMemo(() => {
    if (!selectedDrugs.length) return []

    const grouped = new Map()

    rawData.forEach((row) => {
      if (!selectedDrugs.includes(row.drugInvolved)) return

      if (!grouped.has(row.monthLabel)) {
        grouped.set(row.monthLabel, {
          month: row.monthLabel,
          dateKey: row.dateKey,
        })
      }

      grouped.get(row.monthLabel)[row.drugInvolved] = row.overdoseDeaths
    })

    return Array.from(grouped.values())
      .sort((a, b) => a.dateKey - b.dateKey)
      .map(({ dateKey, ...rest }) => rest)
  }, [rawData, selectedDrugs])

  const chartSeries = useMemo(() => {
    const months = monthlyData.map((row) => row.month)
    const palette = [
      '#2563eb',
      '#16a34a',
      '#f97316',
      '#a855f7',
      '#0ea5e9',
      '#e11d48',
      '#1e293b',
    ]

    const series = selectedDrugs.map((drug, index) => ({
      drug,
      color: palette[index % palette.length],
      points: monthlyData
        .map((row) => ({
          month: row.month,
          value: row[drug] ?? null,
        }))
        .filter((point) => point.value !== null),
    }))

    const yMax =
      Math.max(
        1,
        ...series.flatMap((line) => line.points.map((point) => point.value)),
      ) || 1

    return { months, series, yMax }
  }, [monthlyData, selectedDrugs])

  const toggleDrug = (drug) => {
    setSelectedDrugs((current) =>
      current.includes(drug)
        ? current.filter((item) => item !== drug)
        : [...current, drug],
    )
  }

  const castVote = async (type) => {
    if (type === 'burn' && hasVotedBurn) {
      setVoteError('You already voted against; you can still support.')
      return
    }

    if (type === 'support' && hasVotedBurn) {
      // They already burned; keep the burn vibe and show a gentle reminder.
      setShowBurnLock(true)
      return
    }

    setVoteLoading(true)
    setVoteError('')
    try {
      await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(voteDocRef)
        const current = docSnap.exists()
          ? docSnap.data()
          : { support: 0, burn: 0 }
        const next = {
          ...current,
          [type]: (current[type] || 0) + 1,
        }
        transaction.set(voteDocRef, next)
      })

      if (type === 'burn') {
        setHasVotedBurn(true)
        localStorage.setItem('sosh-voted-burn', 'true')
      }

      setVoteMood(type)
      localStorage.setItem('sosh-vote-mood', type)
    } catch (err) {
      setVoteError(err.message || 'Unable to cast vote')
    } finally {
      setVoteLoading(false)
    }
  }

  const totalVotes = voteCounts.support + voteCounts.burn
  const supportPct = totalVotes
    ? Math.round((voteCounts.support / totalVotes) * 100)
    : 50
  const burnPct = 100 - supportPct

  return (
    <div
      className={`page ${
        voteMood === 'support'
          ? 'theme-support'
          : voteMood === 'burn'
            ? 'theme-burn'
            : ''
      }`}
    >
      {voteMood === 'support' && (
        <>
          <div className="fx fx--confetti" aria-hidden />
          <div className="fx fx--sparkles" aria-hidden />
        </>
      )}
      {voteMood === 'burn' && <div className="fx fx--flames" aria-hidden />}
      {showBurnLock && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <p className="modal__title">
              I appreciate the change of heart, but you've made your choice.
            </p>
            <button
              type="button"
              className="modal__dismiss"
              onClick={() => setShowBurnLock(false)}
            >
              burn
            </button>
          </div>
        </div>
      )}
      <header className="page__header">
        <div>
          <p className="eyebrow">Provisional overdose deaths</p>
          <h1>Monthly deaths by drug</h1>
          <p className="lede">
            Explore 12-month-ending overdose death counts by drug. Select one or
            more drugs to see how totals change over time.
          </p>
        </div>
        <div className="pill">
          Source:{' '}
          <a
            href="https://catalog.data.gov/dataset/provisional-drug-overdose-death-counts-for-specific-drugs"
            target="_blank"
            rel="noreferrer"
          >
            Provisional drug overdose death counts for specific drugs
          </a>
        </div>
      </header>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h2>Segment by drug</h2>
            <p className="helper">
              Toggle one or more drugs to update the monthly time series.
            </p>
          </div>
          <div className="summary">
            <span className="summary__label">Drugs shown</span>
            <span className="summary__value">{selectedDrugs.length}</span>
          </div>
        </div>

        <div className="filters">
          {availableDrugs.map((drug) => (
            <label key={drug} className="filter-pill">
              <input
                type="checkbox"
                checked={selectedDrugs.includes(drug)}
                onChange={() => toggleDrug(drug)}
              />
              <span>{drug}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <h2>Monthly deaths</h2>
            <p className="helper">
              Counts are 12-month-ending totals for the United States.
            </p>
          </div>
          {loading && <span className="pill pill--muted">Loading data…</span>}
          {error && <span className="pill pill--error">{error}</span>}
        </div>

        {!loading && !selectedDrugs.length && (
          <p className="helper">Select at least one drug to see the chart.</p>
        )}

        {!loading && !!selectedDrugs.length && (
          <div className="chart-wrap">
            <svg
              viewBox="0 0 960 360"
              role="img"
              aria-label="Monthly overdose deaths by drug"
            >
              <Chart
                months={chartSeries.months}
                series={chartSeries.series}
                yMax={chartSeries.yMax}
              />
            </svg>
            <div className="chart-legend">
              {chartSeries.series.map((line) => (
                <div key={line.drug} className="legend-item">
                  <span
                    className="legend-swatch"
                    style={{ backgroundColor: line.color }}
                  />
                  <span>{line.drug}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="panel vote-panel">
        <div className="panel__header">
          <div>
            <h2>Voice your stance</h2>
            <p className="helper">
              Cast a vote to support sosh or be against me and burn. Totals update
              live.
            </p>
          </div>
          {voteLoading && <span className="pill pill--muted">Saving…</span>}
          {voteError && <span className="pill pill--error">{voteError}</span>}
        </div>

        <div className="vote-actions">
          <button
            className="vote-btn vote-btn--support"
            onClick={() => castVote('support')}
            disabled={voteLoading}
          >
            Support sosh
          </button>
          <button
            className="vote-btn vote-btn--burn"
            onClick={() => castVote('burn')}
            disabled={voteLoading || hasVotedBurn}
            title={
              hasVotedBurn
                ? 'You already voted against; you can still support.'
                : undefined
            }
          >
            Be against me and burn
          </button>
        </div>

        <div className="vote-meter" aria-label="Vote distribution">
          <div
            className="vote-meter__support"
            style={{ width: `${supportPct}%` }}
            title={`Support ${supportPct}%`}
          />
          <div
            className="vote-meter__burn"
            style={{ width: `${burnPct}%` }}
            title={`Burn ${burnPct}%`}
          />
        </div>

        <div className="vote-stats">
          <span className="support">
            Support: {voteCounts.support.toLocaleString()} ({supportPct}%)
          </span>
          <span className="burn">
            Burn: {voteCounts.burn.toLocaleString()} ({burnPct}%)
          </span>
          <span className="total">Total votes: {totalVotes.toLocaleString()}</span>
        </div>
      </section>

      <footer className="page__footer">
        I, Sosh, am running for president in 2044 when it's legal. Do you see this data? This is horrible, and I will fix it. With me as president, we will get these rookie numbers up! Did you know that gun violence is the leading cause of death for american youths? Well once I'm in office, drug overdoeses will be the number one cause of death, not just for youths, but for everyone. America has a school shooting problem, but kids can't shoot up schools if they overdose on fentanyl first! Support Sosh for Substance Abuse States!
      </footer>
    </div>
  )
}

function Chart({ months, series, yMax }) {
  if (!months.length) return null

  const chartWidth = 960
  const chartHeight = 360
  const paddingLeft = 70
  const paddingRight = 30
  const paddingBottom = 60
  const paddingTop = 20

  const plotWidth = chartWidth - paddingLeft - paddingRight
  const plotHeight = chartHeight - paddingTop - paddingBottom

  const xStep = months.length > 1 ? plotWidth / (months.length - 1) : plotWidth
  const xForMonth = (month) => {
    const index = months.indexOf(month)
    return paddingLeft + index * xStep
  }

  const yForValue = (value) =>
    paddingTop + plotHeight - (value / yMax) * plotHeight

  const labelEvery = Math.max(1, Math.ceil(months.length / 12))

  return (
    <>
      <g>
        <line
          x1={paddingLeft}
          y1={paddingTop + plotHeight}
          x2={paddingLeft + plotWidth}
          y2={paddingTop + plotHeight}
          stroke="#cbd5e1"
        />
        <line
          x1={paddingLeft}
          y1={paddingTop}
          x2={paddingLeft}
          y2={paddingTop + plotHeight}
          stroke="#cbd5e1"
        />

        {series.map((line) => (
          <g key={line.drug}>
            <path
              d={line.points
                .map((point, idx) => {
                  const prefix = idx === 0 ? 'M' : 'L'
                  return `${prefix} ${xForMonth(point.month)} ${yForValue(point.value)}`
                })
                .join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth="2.5"
            />
            {line.points.map((point, idx) => (
              <circle
                key={`${line.drug}-${idx}`}
                cx={xForMonth(point.month)}
                cy={yForValue(point.value)}
                r="3.5"
                fill={line.color}
                stroke="#fff"
                strokeWidth="1"
              >
                <title>
                  {line.drug} · {point.month}: {point.value.toLocaleString()}
                </title>
              </circle>
            ))}
          </g>
        ))}

        {months.map((month, idx) => {
          if (idx % labelEvery !== 0) return null
          const x = xForMonth(month)
          return (
            <g key={month} transform={`translate(${x}, ${paddingTop + plotHeight + 18})`}>
              <text
                textAnchor="middle"
                fontSize="11"
                fill="#475569"
                transform="rotate(35)"
              >
                {month}
              </text>
            </g>
          )
        })}

        {Array.from({ length: 5 }).map((_, idx) => {
          const value = Math.round((yMax / 4) * idx)
          const y = yForValue(value)
          return (
            <g key={value}>
              <line
                x1={paddingLeft}
                y1={y}
                x2={paddingLeft + plotWidth}
                y2={y}
                stroke="#e2e8f0"
                strokeDasharray="4 4"
              />
              <text
                x={paddingLeft - 10}
                y={y + 4}
                textAnchor="end"
                fontSize="11"
                fill="#475569"
              >
                {value.toLocaleString()}
              </text>
            </g>
          )
        })}
      </g>
    </>
  )
}

export default App
