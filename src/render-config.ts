export const exposureControl = {
  min: -10,
  max: 10,
  default: 0,
  stopsPerStep: .15,
};

export const premiumStudio = {
  exposure: 1.03,
  ambient: .42,
  key: .14,
  fill: .16,
  rim: .08,
  softbox: { width: 1.8, height: 1.8, intensity: 4.0 },
  sidebox: { width: .70, height: 1.50, intensity: 1.9 },
  edgebox: { width: .65, height: 1.7, intensity: 1.5 },
  shadow: { radius: 12, intensity: .28 },
  environmentIntensity: .60,
  reflectionCards: [
    { direction: [-.65, -.8, .8], power: 2.7, width: .60, height: .75 },
    { direction: [.9, -.6, .25], power: 1.7, width: .40, height: .95 },
    { direction: [.08, -1, .12], power: .40, width: .70, height: .85 },
    { direction: [.6, .7, .8], power: 1.2, width: .35, height: .70 },
  ] as const,
  legacyMetal: { metalness: 1, minRoughness: .30, maxRoughness: .42, brushedMaxRoughness: .48, anisotropy: .35 },
  ao: { strength: .55, worldRadius: .035, sheetRadius: 12 },
};
