export type ModelOption = {
  value: string;
  label?: string;
  description?: string;
  provider?: string;
};

export type RowProviderFilter = {
  source: string;
  target: string;
};

export type RowOptionSet = {
  source: ModelOption[];
  target: ModelOption[];
};

export function resolveOptionProvider(option: ModelOption): string {
  const explicitProvider = typeof option.provider === 'string' ? option.provider.trim() : '';
  if (explicitProvider) {
    return explicitProvider;
  }

  const description = typeof option.description === 'string' ? option.description : '';
  const firstSegment = description.split(' · ')[0]?.trim() ?? '';
  if (firstSegment && !firstSegment.startsWith('ctx ')) {
    return firstSegment;
  }

  return '';
}

export function normalizeProviderToken(provider: string): string {
  return provider.trim().toLowerCase().replace(/\s+/g, '');
}

export function buildProviderOptions(options: ModelOption[]): string[] {
  return Array.from(
    new Set(
      options
        .map((option) => resolveOptionProvider(option))
        .filter((provider) => provider.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function canonicalizeProviderFilter(provider: string, providerOptions: string[]): string {
  const raw = provider.trim();
  if (!raw) {
    return '';
  }

  if (providerOptions.includes(raw)) {
    return raw;
  }

  const normalizedRaw = normalizeProviderToken(raw);
  const byNormalized = providerOptions.find((candidate) => normalizeProviderToken(candidate) === normalizedRaw);
  if (byNormalized) {
    return byNormalized;
  }

  return raw;
}

export function filterOptionsByProvider(options: ModelOption[], providerFilter: string): ModelOption[] {
  const normalizedProviderFilter = normalizeProviderToken(providerFilter);
  if (!normalizedProviderFilter) {
    return options;
  }

  return options.filter((option) => normalizeProviderToken(resolveOptionProvider(option)) === normalizedProviderFilter);
}

export function buildRowOptions(
  allOptions: ModelOption[],
  rowProviderFilters: RowProviderFilter[],
  rowCount: number
): RowOptionSet[] {
  return Array.from({ length: rowCount }, (_, index) => {
    const rowFilter = rowProviderFilters[index] ?? { source: '', target: '' };
    return {
      source: filterOptionsByProvider(allOptions, rowFilter.source),
      target: filterOptionsByProvider(allOptions, rowFilter.target)
    };
  });
}
