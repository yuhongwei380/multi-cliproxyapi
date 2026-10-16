import { KeyboardEvent, useEffect, useRef, useState } from 'react'

export type DropdownOption = { value: string; label: string }

export type MultiSelectOption = { value: string; label: string; hint?: string; disabled?: boolean }

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

/** 多选下拉：触发区显示已选摘要，菜单内逐项勾选，底部提供全选/清空。 */
export function MultiSelect({ id, label, options, values, onChange, placeholder, summaryPlaceholder, disabled = false, className = '', emptyText = '暂无可选项' }: {
  id: string
  label: string
  options: readonly MultiSelectOption[]
  values: readonly string[]
  onChange: (values: string[]) => void
  placeholder?: string
  summaryPlaceholder?: string
  disabled?: boolean
  className?: string
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectable = options.filter(option => !option.disabled)
  const selectedOptions = options.filter(option => values.includes(option.value))
  const selectedCount = selectedOptions.length
  const allSelected = selectable.length > 0 && selectable.every(option => values.includes(option.value))
  const listboxId = `${id}-listbox`
  const names = selectedOptions.map(option => option.label.split(' · ')[0])
  const summary = selectedCount === 0 ? '' : selectedCount <= 2 ? names.join('、') : (summaryPlaceholder || `已选择 ${selectedCount} 项`)

  const step = (from: number, direction: number) => {
    if (!options.length) return from
    let index = from
    for (let attempt = 0; attempt < options.length; attempt++) {
      index = (index + direction + options.length) % options.length
      if (!options[index].disabled) return index
    }
    return from
  }

  const firstSelectable = () => {
    const index = options.findIndex(option => !option.disabled)
    return index >= 0 ? index : 0
  }

  const lastSelectable = () => {
    for (let index = options.length - 1; index >= 0; index--) if (!options[index].disabled) return index
    return 0
  }

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

  const toggleValue = (option: MultiSelectOption) => {
    if (option.disabled) return
    onChange(values.includes(option.value) ? values.filter(item => item !== option.value) : [...values, option.value])
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = step(activeIndex, 1)
    if (event.key === 'ArrowUp') nextIndex = step(activeIndex, -1)
    if (event.key === 'Home') nextIndex = firstSelectable()
    if (event.key === 'End') nextIndex = lastSelectable()
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
    className={`dropdown-picker dropdown-picker-multi ${className}`.trim()}
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
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-label={`${label}${summary ? `: ${summary}` : ''}`}
      onClick={() => {
        if (disabled || !options.length) return
        if (!open) setActiveIndex(selectedOptions.length ? options.findIndex(option => option.value === selectedOptions[0].value) : firstSelectable())
        setOpen(current => !current)
      }}
      onKeyDown={event => {
        if (disabled) return
        if (open && event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          return
        }
        if (!options.length || open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const index = event.key === 'Home' ? firstSelectable() : event.key === 'End' ? lastSelectable() : selectedOptions.length ? options.findIndex(option => option.value === selectedOptions[0].value) : firstSelectable()
          setActiveIndex(index)
          setOpen(true)
        }
      }}
    >
      <span className={'dropdown-value' + (summary ? '' : ' is-placeholder')}>{summary || placeholder || '\u00a0'}</span>
      <svg className={`dropdown-chevron${open ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4.5 6 3.5 3.5L11.5 6" />
      </svg>
    </button>
    {open && <div className="dropdown-menu is-multi">
      <div className="dropdown-menu-options" id={listboxId} role="listbox" aria-multiselectable="true" aria-label={label} onKeyDown={handleMenuKeyDown}>
        {!options.length && <div className="dropdown-menu-empty">{emptyText}</div>}
        {options.map((option, index) => {
          const checked = values.includes(option.value)
          return <button
            key={option.value}
            ref={element => { optionRefs.current[index] = element }}
            type="button"
            className="dropdown-option dropdown-option-multi"
            role="option"
            aria-selected={checked}
            aria-disabled={option.disabled || undefined}
            disabled={option.disabled}
            tabIndex={activeIndex === index ? 0 : -1}
            data-active={activeIndex === index}
            onFocus={() => setActiveIndex(index)}
            onClick={() => toggleValue(option)}
          >
            <span className="dropdown-option-box" aria-hidden="true" />
            <span className="dropdown-option-text">{option.label}</span>
            {option.hint && <em className="dropdown-option-hint">{option.hint}</em>}
          </button>
        })}
      </div>
      <div className="dropdown-menu-foot">
        <span aria-live="polite">已选择 {selectedCount} / {selectable.length}</span>
        <span className="dropdown-menu-foot-actions">
          <button type="button" disabled={!selectable.length || allSelected} onClick={() => onChange(selectable.map(option => option.value))}>全选</button>
          <button type="button" disabled={!selectedCount} onClick={() => onChange([])}>清空</button>
        </span>
      </div>
    </div>}
  </div>
}
