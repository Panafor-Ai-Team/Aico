import SurfaceSkeleton from '@/components/Skeleton/Surface';
import dynamic from '@/libs/next/dynamic';

const NewAPI = dynamic(() => import('./newapi'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const OpenAI = dynamic(() => import('./openai'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const VertexAI = dynamic(() => import('./vertexai'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const GitHub = dynamic(() => import('./github'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const Ollama = dynamic(() => import('./ollama'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const ComfyUI = dynamic(() => import('./comfyui'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const Cloudflare = dynamic(() => import('./cloudflare'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const Bedrock = dynamic(() => import('./bedrock'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const AzureAI = dynamic(() => import('./azureai'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const Azure = dynamic(() => import('./azure'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const ProviderGrid = dynamic(() => import('../(list)/ProviderGrid'), {
  loading: () => <SurfaceSkeleton header={false} variant={'grid'} />,
  ssr: false,
});
const DefaultPage = dynamic(() => import('./default/ProviderDetialPage'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});
const AicoManagedRedirect = dynamic(() => import('./AicoManagedRedirect'), {
  loading: () => <SurfaceSkeleton header={false} variant={'form'} />,
  ssr: false,
});

type ProviderDetailPageProps = {
  id?: string | null;
  onProviderSelect: (provider: string) => void;
};

const ProviderDetailPage = (props: ProviderDetailPageProps) => {
  const { id, onProviderSelect } = props;

  let content;
  switch (id) {
    case 'all':
    case undefined:
    case null: {
      content = <ProviderGrid onProviderSelect={onProviderSelect} />;
      break;
    }
    case 'aico':
    case 'openrouter': {
      content = <DefaultPage id="openrouter" />;
      break;
    }
    case 'azure': {
      content = <Azure />;
      break;
    }
    case 'azureai': {
      content = <AzureAI />;
      break;
    }
    case 'bedrock': {
      content = <Bedrock />;
      break;
    }
    case 'cloudflare': {
      content = <Cloudflare />;
      break;
    }
    case 'comfyui': {
      content = <ComfyUI />;
      break;
    }
    case 'github': {
      content = <GitHub />;
      break;
    }
    case 'ollama': {
      content = <Ollama />;
      break;
    }
    case 'newapi': {
      content = <NewAPI />;
      break;
    }
    case 'openai': {
      content = <OpenAI />;
      break;
    }
    case 'vertexai': {
      content = <VertexAI />;
      break;
    }
    default: {
      content = <DefaultPage id={id} />;
      break;
    }
  }

  return (
    <AicoManagedRedirect fallback={content} id={id}>
      {content}
    </AicoManagedRedirect>
  );
};

export default ProviderDetailPage;
