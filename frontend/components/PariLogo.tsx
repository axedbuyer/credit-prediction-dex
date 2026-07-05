type PariLogoProps = {
  size?: number
  className?: string
}

export function PariLogo({ size = 26, className }: PariLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="28" stroke="var(--color-teal)" strokeWidth="1.5" />
      <line
        x1="10"
        y1="32"
        x2="54"
        y2="32"
        stroke="var(--color-teal)"
        strokeWidth="0.5"
        strokeDasharray="2 3"
        opacity="0.18"
      />
      <line
        x1="32"
        y1="10"
        x2="32"
        y2="54"
        stroke="var(--color-teal)"
        strokeWidth="0.5"
        strokeDasharray="2 3"
        opacity="0.18"
      />
      <path
        d="M10 50 C18 50,46 14,54 14"
        stroke="var(--color-teal)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
      <circle className="pari-logo-dot" cx="32" cy="32" r="3.5" fill="var(--color-teal)" />
    </svg>
  )
}
