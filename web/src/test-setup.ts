import '@testing-library/jest-dom/vitest'

// jsdom has no modal top layer; browser verification covers native focus/Esc.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
