/** Same shape as the tool-row execution timer so both read identically in chat. */
export const formatGenerationElapsedTime = (ms: number): string => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}min${totalSeconds % 60}s`;
};
