// Espelha app/modules/postrun_calibration.py::linear_fit — só pra prévia
// ao vivo no formulário de calibração "com intercepto" (pedido do
// usuário), antes de enviar pro backend. O valor que realmente vale é
// sempre recalculado no servidor ao aceitar (POST /postrun/calibration).

export interface LinearFitPreview {
  k0: number
  k1: number
  r2: number
}

export function linearFit(points: { area: number; knownMg: number }[]): LinearFitPreview | null {
  if (points.length < 2) return null
  const xs = points.map((p) => p.area)
  const ys = points.map((p) => p.knownMg)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  const ssXX = xs.reduce((s, x) => s + (x - meanX) ** 2, 0)
  if (ssXX === 0) return null
  const ssXY = xs.reduce((s, x, i) => s + (x - meanX) * (ys[i] - meanY), 0)
  const k1 = ssXY / ssXX
  const k0 = meanY - k1 * meanX
  const pred = xs.map((x) => k0 + k1 * x)
  const ssRes = ys.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0)
  const ssTot = ys.reduce((s, y) => s + (y - meanY) ** 2, 0)
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1
  return { k0, k1, r2 }
}
