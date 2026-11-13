export const exposureControl = {
  min: -10,
  max: 10,
  default: 0,
  stopsPerStep: .15,
};

export const premiumStudio = {
  exposure: 1.03,
  ambient: .34,
  key: .33,
  fill: .12,
  rim: .06,
  softbox: { width: 1.72, height: 1.28, intensity: 3.0 },
  sidebox: { width: .82, height: 1.62, intensity: 1.38 },
  shadow: { radius: 12, intensity: .36 },
  environmentIntensity: .58,
  reflectionCards: [
    { direction: [-.56, -.70, .45], power: 3.2, width: .34, height: .55 },
    { direction: [.85, -.13, .32], power: 2.15, width: .26, height: .62 },
    { direction: [-.12, .22, .97], power: 1.5, width: .48, height: .52 },
  ] as const,
  legacyMetal: { metalness: .82, minRoughness: .28, maxRoughness: .38, brushedMaxRoughness: .43, anisotropy: .45 },
  ao: { strength: .70, worldRadius: .095, sheetRadius: 16 },
};
