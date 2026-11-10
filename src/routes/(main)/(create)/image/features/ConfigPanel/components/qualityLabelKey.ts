/** Map a quality enum value to its i18n key under `image`, or null to use the raw value. */
export const qualityLabelKey = (quality: string): `config.quality.options.${string}` | null => {
  switch (quality) {
    case 'auto':
    case 'high':
    case 'hd':
    case 'low':
    case 'medium':
    case 'standard': {
      return `config.quality.options.${quality}`;
    }
    default: {
      return null;
    }
  }
};
