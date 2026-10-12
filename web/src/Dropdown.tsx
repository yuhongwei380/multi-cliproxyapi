import { KeyboardEvent, useEffect, useRef, useState } from 'react'

export type DropdownOption = { value: string; label: string }

export function Dropdown({ id, label, options, value, onChange, placeholder, className = '', disabled = false }: {
  id: string
  label: string
  options: readonly DropdownOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = options.findIndex(option => option.value === value)
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : placeholder
  const listboxId = `${id}-listbox`

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const toggle = () => {
    if (disabled || !options.length) return
    if (!open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(current => !current)
  }

  const choose = (option: DropdownOption) => {
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const lastIndex = options.length - 1
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % options.length
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + options.length) % options.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = lastIndex
    if (nextIndex !== null) {
      event.preventDefault()
      setActiveIndex(nextIndex)
      optionRefs.current[nextIndex]?.focus()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return <div
    className={`dropdown-picker ${className}`.trim()}
    ref={pickerRef}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
    }}
  >
    <button
      disabled={disabled}
      id={id}
      ref={triggerRef}
      type="button"
      className="dropdown-trigger"
      role="combobox"
      aria-label={`${label}${selectedLabel ? `: ${selectedLabel}` : ''}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      onClick={toggle}
      onKeyDown={event => {
        if (!disabled && options.length && !open && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End')) {
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : selectedIndex >= 0 ? selectedIndex : 0
          setActiveIndex(index)
          setOpen(true)
        }
      }}
    >
      <span className="dropdown-value">{selectedLabel || placeholder || '\u00a0'}</span>
      <svg className={`dropdown-chevron${open ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4.5 6 3.5 3.5L11.5 6" />
      </svg>
    </button>
    {open && <div
      className="dropdown-menu"
      id={listboxId}
      role="listbox"
      aria-label={label}
      onKeyDown={handleMenuKeyDown}
    >
      {options.map((option, index) => <button
        key={option.value}
        ref={element => { optionRefs.current[index] = element }}
        type="button"
        className="dropdown-option"
        role="option"
        aria-selected={value === option.value}
        tabIndex={activeIndex === index ? 0 : -1}
        data-active={activeIndex === index}
        onFocus={() => setActiveIndex(index)}
        onClick={() => choose(option)}
      >
        <span>{option.label}</span>
        <svg className="dropdown-option-check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 8.25 2.75 2.5 6-5.5" />
        </svg>
      </button>)}
    </div>}
  </div>
}
