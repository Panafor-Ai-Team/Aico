/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ModelRating } from 'model-bank';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnabledProviderWithModels } from '@/types/aiProvider';

import ModelDetailPanel from './ModelDetailPanel';

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({
    actionText: 'actionText',
    container: 'container',
    description: 'description',
    originalPriceText: 'originalPriceText',
    priceValue: 'priceValue',
    radarClickable: 'radarClickable',
    row: 'row',
    titleText: 'titleText',
  }),
  cssVar: new Proxy({}, { get: (_, token) => `var(--${String(token)})` }),
}));

// recharts needs a measured container — stub the chart with its data flattened to text nodes
vi.mock('@lobehub/charts', () => ({
  RadarChart: ({ data }: { data: Record<string, unknown>[] }) => (
    <svg data-testid={'radar-chart'}>
      {data.map((row, i) => (
        <g key={i}>
          {Object.values(row).map((value, j) => (
            <text key={j}>{String(value)}</text>
          ))}
        </g>
      ))}
    </svg>
  ),
}));

// keep the panel test free of the modal's own dependency chain (@lobehub/ui/base-ui, i18next)
vi.mock('./BenchmarkModal', () => ({
  openBenchmarkModal: vi.fn(),
}));

vi.mock('@lobehub/ui', () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({
    action,
    children,
    title,
  }: {
    action?: ReactNode;
    children?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      <div>{title}</div>
      <div>{action}</div>
      <div>{children}</div>
    </section>
  ),
  Flexbox: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Icon: () => <span />,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Text: ({ children, ...props }: { children: ReactNode }) => {
    const { type: _type, ...rest } = props as Record<string, unknown>;

    return <p {...rest}>{children}</p>;
  },
  Tooltip: ({ children, title }: { children: ReactNode; title?: ReactNode }) => (
    <span>
      {title}
      {children}
    </span>
  ),
}));

vi.mock('@/hooks/useEnabledChatModels', () => ({
  useEnabledChatModels: () => [],
}));

let mockRating: ModelRating | undefined;

vi.mock('@/business/client/hooks/useBusinessModelRating', () => ({
  useBusinessModelRating: () => () => mockRating,
}));

const globalState = {
  status: {
    modelDetailPanelExpandedKeys: ['pricing'],
  },
  updateModelDetailPanelExpandedKeys: vi.fn(),
};

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: typeof globalState) => unknown) => selector(globalState),
}));

vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: {
    modelDetailPanelExpandedKeys: (state: typeof globalState) =>
      state.status.modelDetailPanelExpandedKeys,
  },
}));

const translations: Record<string, string> = {
  'ModelSwitchPanel.detail.context': 'Context Length',
  'ModelSwitchPanel.detail.pricing': 'Pricing',
  'ModelSwitchPanel.detail.pricing.credits.input': 'Input {{amount}} π/M tokens',
  'ModelSwitchPanel.detail.pricing.credits.output': 'Output {{amount}} π/M tokens',
  'ModelSwitchPanel.detail.pricing.credits.perImage': '~ {{amount}} π / image',
  'ModelSwitchPanel.detail.pricing.credits.perVideo': '~ {{amount}} π / video',
  'ModelSwitchPanel.detail.pricing.credits.image': 'π/img',
  'ModelSwitchPanel.detail.pricing.credits.millionTokens': 'π/M tokens',
  'ModelSwitchPanel.detail.pricing.group.image': 'Image',
  'ModelSwitchPanel.detail.pricing.group.text': 'Text',
  'ModelSwitchPanel.detail.pricing.input': 'Input ${{amount}}/M',
  'ModelSwitchPanel.detail.pricing.output': 'Output ${{amount}}/M',
  'ModelSwitchPanel.detail.pricing.perImage': '~ ${{amount}} / image',
  'ModelSwitchPanel.detail.pricing.perVideo': '~ ${{amount}} / video',
  'ModelSwitchPanel.detail.pricing.unit.imageGeneration': 'Image Generation',
  'ModelSwitchPanel.detail.pricing.unit.textInput': 'Input',
  'ModelSwitchPanel.detail.pricing.unit.textOutput': 'Output',
  'ModelSwitchPanel.detail.rating': 'Benchmarks',
  'ModelSwitchPanel.detail.rating.dimension.agentic': 'Agentic',
  'ModelSwitchPanel.detail.rating.dimension.design': 'Design',
  'ModelSwitchPanel.detail.rating.dimension.intelligence': 'Intelligence',
  'ModelSwitchPanel.detail.rating.dimension.price': 'Price',
  'ModelSwitchPanel.detail.rating.dimension.speed': 'Speed',
  'ModelSwitchPanel.detail.rating.dimension.writing': 'Writing',
  'test-model.description': 'Localized model description.',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key] ?? options?.defaultValue ?? key;

      return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    },
  }),
}));

const textPricing = {
  currency: 'USD',
  units: [
    { name: 'textInput', rate: 5, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textOutput', rate: 25, strategy: 'fixed', unit: 'millionTokens' },
  ],
};

const imagePricing = {
  approximatePricePerImage: 0.04,
  approximatePricePerVideo: 0.8,
  currency: 'USD',
  units: [{ name: 'imageGeneration', rate: 0.04, strategy: 'fixed', unit: 'image' }],
};

const emptyLookupPricing = {
  currency: 'USD',
  units: [
    {
      lookup: { prices: {} },
      name: 'imageGeneration',
      strategy: 'lookup',
      unit: 'image',
    },
  ],
};

const discountedTextPricing = {
  currency: 'USD',
  units: [
    { name: 'textInput', originalRate: 5, rate: 2.5, strategy: 'fixed', unit: 'millionTokens' },
  ],
};

const createEnabledList = (
  provider: string,
  pricing: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): EnabledProviderWithModels[] => [
  {
    children: [
      {
        abilities: {},
        contextWindowTokens: 1_000_000,
        displayName: 'Test Model',
        id: 'test-model',
        pricing,
        type: 'chat',
        ...overrides,
      } as any,
    ],
    id: provider,
    name: provider,
    source: 'builtin',
  },
];

describe('ModelDetailPanel pricing', () => {
  it('renders the localized model description when provided', () => {
    const { container } = render(
      <ModelDetailPanel
        model="test-model"
        provider="lobehub"
        enabledList={createEnabledList('lobehub', textPricing, {
          description: 'Fallback model description.',
        })}
      />,
    );

    expect(container.querySelector('.description')).toHaveTextContent(
      'Localized model description.',
    );
  });

  it('renders managed provider token pricing in π', () => {
    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openrouter', textPricing)}
        model="test-model"
        provider="openrouter"
      />,
    );

    expect(screen.getByText('125,000 π/M tokens')).toBeInTheDocument();
    expect(screen.getByText('625,000 π/M tokens')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('$5.00');
  });

  it('renders the original managed price without repeating the unit suffix', () => {
    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openrouter', discountedTextPricing)}
        model="test-model"
        provider="openrouter"
      />,
    );

    const originalPrice = container.querySelector('.originalPriceText');

    expect(originalPrice).toHaveTextContent('125,000');
    expect(originalPrice).not.toHaveTextContent('π/M tokens');
    expect(container).toHaveTextContent('62,500 π/M tokens');
  });

  it('keeps dollar pricing for non-managed providers', () => {
    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openai', textPricing)}
        model="test-model"
        provider="openai"
      />,
    );

    expect(container).toHaveTextContent('$5.00/M tokens');
    expect(container).toHaveTextContent('$25.00/M tokens');
    expect(container).not.toHaveTextContent('π/M tokens');
  });

  it('renders managed provider image and video pricing in π', () => {
    const imageResult = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openrouter', imagePricing)}
        model="test-model"
        pricingMode="image"
        provider="openrouter"
      />,
    );

    expect(imageResult.container).toHaveTextContent('~ 1,000 π / image');
    expect(imageResult.container).toHaveTextContent('1,000 π/img');
    expect(imageResult.container).not.toHaveTextContent('$0.04');

    imageResult.unmount();

    const videoResult = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openrouter', imagePricing)}
        model="test-model"
        pricingMode="video"
        provider="openrouter"
      />,
    );

    expect(videoResult.container).toHaveTextContent('~ 20,000 π / video');
    expect(videoResult.container).not.toHaveTextContent('$0.80');
  });

  it('renders a placeholder for empty lookup pricing tables', () => {
    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('openrouter', emptyLookupPricing)}
        model="test-model"
        provider="openrouter"
      />,
    );

    expect(container).toHaveTextContent('Image Generation');
    expect(container).toHaveTextContent('- π/img');
  });
});

describe('ModelDetailPanel rating', () => {
  beforeEach(() => {
    mockRating = undefined;
  });

  const score = (value: number): NonNullable<ModelRating['intelligence']> => ({
    raw: value * 10,
    score: value,
    source: 'artificial-analysis',
    sourceUrl: 'https://artificialanalysis.ai/models/test-model',
    updatedAt: '2026-07-10',
  });

  it('hides the benchmarks section when the model has no rating', () => {
    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('lobehub', textPricing)}
        model="test-model"
        provider="lobehub"
      />,
    );

    expect(container).not.toHaveTextContent('Benchmarks');
  });

  it('renders the radar chart when five or more dimensions are rated', () => {
    mockRating = {
      design: score(78),
      intelligence: score(100),
      price: score(35),
      speed: score(60),
      writing: score(88),
    };

    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('lobehub', textPricing)}
        model="test-model"
        provider="lobehub"
      />,
    );

    expect(container).toHaveTextContent('Benchmarks');
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container).toHaveTextContent('Intelligence');
    expect(container).toHaveTextContent('100');
    // agentic has no data: the dimension is omitted from the radar entirely
    expect(container).not.toHaveTextContent('Agentic');
  });

  it('renders a dimension list instead of the radar below five dimensions', () => {
    mockRating = {
      intelligence: score(91),
      price: score(42),
      speed: score(66),
    };

    const { container } = render(
      <ModelDetailPanel
        enabledList={createEnabledList('lobehub', textPricing)}
        model="test-model"
        provider="lobehub"
      />,
    );

    expect(container).toHaveTextContent('Benchmarks');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('Intelligence');
    expect(container).toHaveTextContent('91');
    // unrated dimensions are not listed in the fallback view
    expect(container).not.toHaveTextContent('Writing');
  });
});
