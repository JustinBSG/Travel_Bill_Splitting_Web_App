// Line icons (24px grid, round caps). Circles are written as two arcs so every
// icon is a single path.
const c = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

const PATHS = {
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14zM10 20.5a2.2 2.2 0 0 0 4 0',
  settings: `M4 7h9M17 7h3M4 17h3M11 17h9${c(15, 7, 2)}${c(9, 17, 2)}`,
  plus: 'M12 5v14M5 12h14',
  share: 'M12 3.5v11M8 7.5l4-4 4 4M5.5 11.5v7a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-7',
  copy: 'M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2',
  lock: 'M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3',
  unlock: 'M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8.5 10.5v-3a3.5 3.5 0 0 1 6.8-1.2',
  camera: `M4.5 8.5h3l1.5-2.5h6l1.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z${c(12, 13.5, 3.3)}`,
  image: `M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5z${c(8.8, 9.3, 1.6)}M20.5 15.5l-5-5L5 19.5`,
  pin: `M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z${c(12, 10, 2.3)}`,
  users: `${c(9, 8.5, 3.5)}M2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.3`,
  history: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5M12 8v4.5l3 2',
  download: 'M12 4v11M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13',
  info: `${c(12, 12, 8.5)}M12 11v5.5M12 7.8h.01`,
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  arrowRight: 'M4.5 12h15M13.5 6l6 6-6 6',
  calendar: 'M6 5.5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM4 10h16M8.5 3.5v4M15.5 3.5v4',
  calendarRange: 'M5.5 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 9.5h17M8 3v4M16 3v4M7.5 14.5h9',
  clock: `${c(12, 12, 8.5)}M12 7.5V12l3 2`,
  mail: 'M5.5 5.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM4 7l8 6 8-6',
  search: `${c(11, 11, 6.5)}M16 16l4.5 4.5`,
  restore: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9',
  sun: `${c(12, 12, 3.8)}M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4`,
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z',
  // categories
  food: 'M3.5 12.5h17M5 12.5a7 7 0 0 0 14 0M9.5 20.5h5M13.5 3.5l-3 9M18.5 4.5l-5.5 8',
  transport: 'M9 3.5h6a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3zM6 10.5h12M9 13.8h.01M15 13.8h.01M8.5 16.5l-2 4M15.5 16.5l2 4',
  bed: `M3.5 6v13.5M3.5 15.5h17v4M20.5 15.5v-3a3 3 0 0 0-3-3H10v6${c(6.8, 12.3, 1.8)}`,
  ticket:
    'M4 8a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 8v2.2a1.8 1.8 0 0 0 0 3.6V16a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16v-2.2a1.8 1.8 0 0 0 0-3.6zM14.5 6.5v2M14.5 11v2M14.5 15.5v2',
  bag: 'M5.5 8.5h13l-1 11.5h-11zM9 8.5V7a3 3 0 0 1 6 0v1.5',
  basket: 'M3.5 10h17l-2 9.5h-13zM8 10l2.5-5.5M16 10l-2.5-5.5M9.5 13.5v3M14.5 13.5v3',
  loan: 'M4 8.5h14M14.5 5l3.5 3.5-3.5 3.5M20 15.5H6M9.5 12L6 15.5 9.5 19',
  box: 'M4 7.5l8-4 8 4v9l-8 4-8-4zM4 7.5l8 4 8-4M12 11.5v9',
  // weather
  partlyCloudy: `${c(8.5, 8.5, 3)}M8.5 3v1.2M3 8.5h1.2M4.6 4.6l.85.85M12.4 4.6l-.85.85M9 19.5h8.5a3.5 3.5 0 0 0 .3-7 4.5 4.5 0 0 0-8.4 1A3 3 0 0 0 9 19.5z`,
  cloud: 'M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11.6a3.5 3.5 0 0 0 .5 6.9z',
  fog: 'M7.5 13h9.5a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7 6.8a3.1 3.1 0 0 0 .5 6.2zM5 16.5h14M7 20h10',
  drizzle: 'M7.5 15h9.5a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7 8.8a3.1 3.1 0 0 0 .5 6.2zM9 18.5v.5M13 18.5v.5M17 18.5v.5M11 20.5v.5M15 20.5v.5',
  rain: 'M7.5 15h9.5a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7 8.8a3.1 3.1 0 0 0 .5 6.2zM9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5',
  snow: 'M7.5 15h9.5a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7 8.8a3.1 3.1 0 0 0 .5 6.2zM9 18.5h.01M13 18.5h.01M17 18.5h.01M11 21h.01M15 21h.01',
  thunder: 'M7.5 15h9.5a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7 8.8a3.1 3.1 0 0 0 .5 6.2zM12.5 15l-2 3.5h3l-2 3.5',
  thermometer: `M10 13.5V5a2 2 0 0 1 4 0v8.5${c(12, 16.5, 3)}`,
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, label, stroke = 1.8 }: { name: IconName; size?: number; label?: string; stroke?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      className="icon"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** iOS Share glyph for the install banner. */
export function IosShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M12 3v12M8 7l4-4 4 4M5 11v9a1 1 0 001 1h12a1 1 0 001-1v-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
