// @vitest-environment node
import * as imageToBase64Module from '@lobechat/utils';
import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateImagePayload } from '../../types/image';
import * as uriParserModule from '../../utils/uriParser';
import { createOpenAICompatibleImage } from './createImage';

// Mock the console to avoid polluting test output
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

// Polyfill File for Node environment
if (typeof File === 'undefined') {
  // @ts-ignore
  global.File = class MockFile {
    constructor(
      public parts: any[],
      public name: string,
      public opts?: any,
    ) {}
  };
}

describe('createOpenAICompatibleImage', () => {
  let mockClient: OpenAI;

  beforeEach(() => {
    // Create a mock OpenAI client
    mockClient = {
      images: {
        generate: vi.fn(),
        edit: vi.fn(),
      },
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as any;

    vi.clearAllMocks();
  });

  describe('chat model mode (model with :image suffix)', () => {
    describe('processImageUrlForChat function', () => {
      it('should process base64 data URI correctly', async () => {
        const mockImageUrl =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        });

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,generatedImageData',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'gemini-2.0-flash-exp:image',
          params: {
            prompt: 'Edit this image',
            imageUrl: mockImageUrl,
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter');

        expect(result.imageUrl).toBe('data:image/png;base64,generatedImageData');
        expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            modalities: ['image', 'text'],
            model: 'gemini-2.0-flash-exp',
          }),
        );
      });

      it('should process base64 data URI without mimeType', async () => {
        const mockImageUrl = 'data:;base64,someBase64Data';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64: 'someBase64Data',
          mimeType: null,
        });

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,result',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Process this',
            imageUrl: mockImageUrl,
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

        expect(result.imageUrl).toBe('data:image/png;base64,result');
      });

      it('should throw error when base64 data is missing in data URI', async () => {
        const mockImageUrl = 'data:image/png;base64,';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64: null,
          mimeType: 'image/png',
        });

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Process this',
            imageUrl: mockImageUrl,
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow(
          `Failed to process image URL (${mockImageUrl}): Image URL doesn't contain base64 data`,
        );
      });

      it('should forward a remote URL reference untouched by default (no server-side fetch)', async () => {
        const mockHttpImageUrl = 'https://example.com/image.jpg';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'url',
          base64: null,
          mimeType: null,
        });

        const fetchSpy = vi.spyOn(imageToBase64Module, 'imageUrlToBase64');

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,output',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'vision-model:image',
          params: {
            prompt: 'Convert and process',
            imageUrl: mockHttpImageUrl,
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

        // The server must not dereference the reference image itself — that
        // self-fetch is what breaks Image Create behind SSRF protection.
        // The provider fetches the URL directly, exactly like chat does.
        expect(fetchSpy).not.toHaveBeenCalled();
        const callArgs = vi.mocked(mockClient.chat.completions.create).mock.calls[0][0] as any;
        expect(callArgs.messages[0].content[1]).toEqual({
          image_url: { url: mockHttpImageUrl },
          type: 'image_url',
        });
        expect(result.imageUrl).toBe('data:image/png;base64,output');
      });

      it('should still convert a remote URL to base64 when LLM_VISION_IMAGE_USE_BASE64=1', async () => {
        const mockHttpImageUrl = 'https://example.com/image.jpg';
        const previous = process.env.LLM_VISION_IMAGE_USE_BASE64;
        process.env.LLM_VISION_IMAGE_USE_BASE64 = '1';

        try {
          vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
            type: 'url',
            base64: null,
            mimeType: null,
          });

          vi.spyOn(imageToBase64Module, 'imageUrlToBase64').mockResolvedValue({
            base64: 'convertedBase64Data',
            mimeType: 'image/jpeg',
          });

          const mockChatResponse = {
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url: 'data:image/png;base64,output',
                      },
                    },
                  ],
                },
              },
            ],
          };

          vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

          const payload: CreateImagePayload = {
            model: 'vision-model:image',
            params: {
              prompt: 'Convert and process',
              imageUrl: mockHttpImageUrl,
            },
          };

          const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

          expect(imageToBase64Module.imageUrlToBase64).toHaveBeenCalledWith(mockHttpImageUrl);
          expect(result.imageUrl).toBe('data:image/png;base64,output');
        } finally {
          process.env.LLM_VISION_IMAGE_USE_BASE64 = previous;
        }
      });

      it('should throw error for unsupported image URL type', async () => {
        const mockInvalidUrl = 'file:///local/path/image.png';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: null,
          base64: null,
          mimeType: null,
        });

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Process this',
            imageUrl: mockInvalidUrl,
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow(
          `Failed to process image URL (${mockInvalidUrl}): Currently we don't support image url: ${mockInvalidUrl}`,
        );
      });

      it('should send multiple reference images from imageUrls', async () => {
        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64: 'someBase64Data',
          mimeType: null,
        });

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,multi',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Combine these images',
            imageUrls: ['data:image/png;base64,one', 'data:image/png;base64,two'],
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

        expect(result.imageUrl).toBe('data:image/png;base64,multi');

        const callArgs = vi.mocked(mockClient.chat.completions.create).mock.calls[0][0] as any;
        // text prompt + 2 reference images
        expect(callArgs.messages[0].content).toHaveLength(3);
        expect(callArgs.messages[0].content[1].type).toBe('image_url');
        expect(callArgs.messages[0].content[2].type).toBe('image_url');
      });

      it('should combine imageUrl and imageUrls as reference images', async () => {
        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64: 'someBase64Data',
          mimeType: null,
        });

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,combined',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Edit with reference',
            imageUrl: 'data:image/png;base64,main',
            imageUrls: ['data:image/png;base64,ref'],
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

        expect(result.imageUrl).toBe('data:image/png;base64,combined');

        const callArgs = vi.mocked(mockClient.chat.completions.create).mock.calls[0][0] as any;
        // text prompt + imageUrl + imageUrls entry
        expect(callArgs.messages[0].content).toHaveLength(3);
      });
    });

    describe('generateByChatModel function', () => {
      it('should generate image without imageUrl parameter', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,generatedWithoutInputImage',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'gemini-2.0-flash:image',
          params: {
            prompt: 'Generate a cat image',
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter');

        expect(result.imageUrl).toBe('data:image/png;base64,generatedWithoutInputImage');
        expect(mockClient.chat.completions.create).toHaveBeenCalledWith({
          messages: [
            {
              content: [
                {
                  text: 'Generate a cat image',
                  type: 'text',
                },
              ],
              role: 'user',
            },
          ],
          modalities: ['image', 'text'],
          model: 'gemini-2.0-flash',
          stream: false,
          usage: { include: true },
        });
      });

      it('should handle null imageUrl parameter', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,generatedImage',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
            imageUrl: null as any,
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

        expect(result.imageUrl).toBe('data:image/png;base64,generatedImage');
        // Should not include image in content array
        const callArgs = vi.mocked(mockClient.chat.completions.create).mock.calls[0][0] as any;
        expect(callArgs.messages[0].content).toHaveLength(1);
        expect(callArgs.messages[0].content[0].type).toBe('text');
      });

      it('should throw error when no message in response', async () => {
        const mockChatResponse = {
          choices: [
            {
              // message is missing
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow('No message in chat completion response');
      });

      it('should throw error when images array is missing', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                content: 'Some text response',
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow('No image generated in chat completion response');
      });

      it('should throw error when images array is empty', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow('No image generated in chat completion response');
      });

      it('should throw error when image_url is missing in images array', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    // image_url is missing
                    someOtherField: 'value',
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow('No image generated in chat completion response');
      });

      it('should throw error when url is missing in image_url object', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      // url is missing
                      detail: 'high',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'test-model:image',
          params: {
            prompt: 'Generate image',
          },
        };

        await expect(
          createOpenAICompatibleImage(mockClient, payload, 'test-provider'),
        ).rejects.toThrow('No image generated in chat completion response');
      });

      it('should request usage.include and populate modelUsage from the provider-reported cost', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,withUsage',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            completion_tokens: 1290,
            cost: 0.0391,
            prompt_tokens: 10,
            total_tokens: 1300,
          },
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'gemini-2.0-flash:image',
          params: {
            prompt: 'Generate a cat image',
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter');

        expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
          expect.objectContaining({ usage: { include: true } }),
        );
        expect(result.imageUrl).toBe('data:image/png;base64,withUsage');
        expect(result.modelUsage?.cost).toBe(0.0391);
      });

      it('should not include modelUsage when the chat completion response has no usage', async () => {
        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,noUsage',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'gemini-2.0-flash:image',
          params: {
            prompt: 'Generate a cat image',
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter');

        expect(result.imageUrl).toBe('data:image/png;base64,noUsage');
        expect(result.modelUsage).toBeUndefined();
      });

      it('should successfully process image with valid imageUrl', async () => {
        const mockImageUrl = 'data:image/jpeg;base64,validBase64Data';

        vi.spyOn(uriParserModule, 'parseDataUri').mockReturnValue({
          type: 'base64',
          base64: 'validBase64Data',
          mimeType: 'image/jpeg',
        });

        const mockChatResponse = {
          choices: [
            {
              message: {
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,processedResult',
                    },
                  },
                ],
              },
            },
          ],
        };

        vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

        const payload: CreateImagePayload = {
          model: 'vision-model:image',
          params: {
            prompt: 'Edit this image by adding a sunset',
            imageUrl: mockImageUrl,
          },
        };

        const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter');

        expect(result.imageUrl).toBe('data:image/png;base64,processedResult');

        const callArgs = vi.mocked(mockClient.chat.completions.create).mock.calls[0][0] as any;
        expect(callArgs.messages[0].content).toHaveLength(2);
        expect(callArgs.messages[0].content[0]).toEqual({
          text: 'Edit this image by adding a sunset',
          type: 'text',
        });
        expect(callArgs.messages[0].content[1]).toEqual({
          image_url: {
            url: mockImageUrl,
          },
          type: 'image_url',
        });
      });
    });
  });

  describe('routing logic', () => {
    it('should route to chat model when model ends with :image', async () => {
      const mockChatResponse = {
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: 'data:image/png;base64,chatModelResult',
                  },
                },
              ],
            },
          },
        ],
      };

      vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

      const payload: CreateImagePayload = {
        model: 'some-model:image',
        params: {
          prompt: 'Test routing',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider');

      expect(result.imageUrl).toBe('data:image/png;base64,chatModelResult');
      expect(mockClient.chat.completions.create).toHaveBeenCalled();
      expect(mockClient.images.generate).not.toHaveBeenCalled();
      expect(mockClient.images.edit).not.toHaveBeenCalled();
    });

    it('should route by logical image model while sending mapped model id', async () => {
      const mockChatResponse = {
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: 'data:image/png;base64,mappedChatModelResult',
                  },
                },
              ],
            },
          },
        ],
      };

      vi.mocked(mockClient.chat.completions.create).mockResolvedValue(mockChatResponse as any);

      const payload: CreateImagePayload = {
        model: 'logical-model:image',
        params: {
          prompt: 'Test mapped routing',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'test-provider', {
        requestModel: 'upstream-model',
        routingModel: 'logical-model:image',
      });

      expect(result.imageUrl).toBe('data:image/png;base64,mappedChatModelResult');
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'upstream-model' }),
      );
      expect(mockClient.images.generate).not.toHaveBeenCalled();
      expect(mockClient.images.edit).not.toHaveBeenCalled();
    });

    it('should route to image mode when model does not end with :image', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'imageModelBase64Result',
          },
        ],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Test traditional image generation',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,imageModelBase64Result');
      expect(mockClient.images.generate).toHaveBeenCalled();
      expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
    });
  });

  describe('image mode - parameter mapping', () => {
    it('should map single imageUrl string parameter to image array', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'editedImageResult',
          },
        ],
      };

      // Mock fetch for image download
      const mockArrayBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockArrayBuffer,
        headers: {
          get: (name: string) => (name === 'content-type' ? 'image/jpeg' : null),
        },
      } as any);

      vi.mocked(mockClient.images.edit).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-2',
        params: {
          prompt: 'Edit image',
          imageUrl: 'https://example.com/single-image.jpg',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,editedImageResult');
      expect(mockClient.images.edit).toHaveBeenCalled();
    });

    it('should handle imageUrl with empty string by not converting to array', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'generatedImage',
          },
        ],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Generate image',
          imageUrl: '',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,generatedImage');
      expect(mockClient.images.generate).toHaveBeenCalled();
      expect(mockClient.images.edit).not.toHaveBeenCalled();
    });

    it('should handle imageUrl with whitespace-only string', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'generatedImage',
          },
        ],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Generate image',
          imageUrl: '   ',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,generatedImage');
      expect(mockClient.images.generate).toHaveBeenCalled();
      expect(mockClient.images.edit).not.toHaveBeenCalled();
    });
  });

  describe('image mode - response format handling', () => {
    it('should handle URL format response instead of base64', async () => {
      const mockImageUrl = 'https://oaidalleapiprodscus.blob.core.windows.net/generated/image.png';
      const mockImageResponse = {
        data: [
          {
            url: mockImageUrl,
          },
        ],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Generate image with URL response',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe(mockImageUrl);
      expect(mockClient.images.generate).toHaveBeenCalled();
    });

    it('should throw error when imageData has neither url nor b64_json', async () => {
      const mockImageResponse = {
        data: [
          {
            // Missing both url and b64_json
            revised_prompt: 'some prompt',
          },
        ],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Test',
        },
      };

      await expect(createOpenAICompatibleImage(mockClient, payload, 'openai')).rejects.toThrow(
        'Invalid image response: missing both b64_json and url fields',
      );
    });

    it('should throw error when response data is not an array', async () => {
      const mockImageResponse = {
        data: 'not an array',
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Test',
        },
      };

      await expect(createOpenAICompatibleImage(mockClient, payload, 'openai')).rejects.toThrow(
        'Invalid image response: missing or empty data array',
      );
    });

    it('should throw error when imageData is undefined in array', async () => {
      const mockImageResponse = {
        data: [undefined],
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Test',
        },
      };

      await expect(createOpenAICompatibleImage(mockClient, payload, 'openai')).rejects.toThrow(
        'Invalid image response: first data item is null or undefined',
      );
    });
  });

  describe('chat model mode - response extraction shapes', () => {
    const usage = {
      total_tokens: 1000,
      input_tokens: 100,
      output_tokens: 900,
      input_tokens_details: { text_tokens: 50, image_tokens: 50 },
    };
    const payload: CreateImagePayload = {
      model: 'google/gemini-3.1-flash-image-preview:image',
      params: { prompt: 'make it red' },
    };

    const runWithMessage = async (message: any) => {
      vi.mocked(mockClient.chat.completions.create).mockResolvedValue({
        choices: [{ message }],
        usage,
      } as any);
      return createOpenAICompatibleImage(mockClient, payload, 'openrouter');
    };

    it('extracts from message.images (existing shape)', async () => {
      const result = await runWithMessage({
        images: [{ image_url: { url: 'https://cdn/img.png' } }],
      });
      expect(result.imageUrl).toBe('https://cdn/img.png');
      expect(result.modelUsage).toBeDefined();
    });

    it('extracts from multimodal content parts', async () => {
      const result = await runWithMessage({
        content: [{ type: 'image_url', image_url: { url: 'https://cdn/part.png' } }],
      });
      expect(result.imageUrl).toBe('https://cdn/part.png');
      expect(result.modelUsage).toBeDefined();
    });

    it('extracts b64_json content parts as a data URI', async () => {
      const result = await runWithMessage({
        content: [{ type: 'image', b64_json: 'abc123' }],
      });
      expect(result.imageUrl).toBe('data:image/png;base64,abc123');
      expect(result.modelUsage).toBeDefined();
    });

    it('extracts a data URI embedded in string content', async () => {
      const result = await runWithMessage({
        content: 'Here you go: data:image/png;base64,AAAbbb111 enjoy',
      });
      expect(result.imageUrl).toBe('data:image/png;base64,AAAbbb111');
      expect(result.modelUsage).toBeDefined();
    });

    it('extracts a markdown image from string content', async () => {
      const result = await runWithMessage({
        content: '![out](https://cdn/markdown.png)',
      });
      expect(result.imageUrl).toBe('https://cdn/markdown.png');
      expect(result.modelUsage).toBeDefined();
    });

    it('still throws when the response carries no image at all', async () => {
      await expect(runWithMessage({ content: 'sorry, I cannot do that' })).rejects.toThrow(
        'No image generated in chat completion response',
      );
    });
  });

  describe('image mode - imageEditMode: inputReferences', () => {
    const editedResponse = { data: [{ b64_json: 'editedViaInputReferences' }] };

    // Any call to this means we tried to download the reference server-side,
    // which is both unnecessary and SSRF-prone for the input_references transport.
    const failIfFetched = () =>
      vi.fn().mockImplementation(() => {
        throw new Error('reference image must not be fetched server-side');
      });

    it('never calls /images/edits for OpenRouter reference-image edits', async () => {
      global.fetch = failIfFetched() as any;
      vi.mocked(mockClient.images.generate).mockResolvedValue(editedResponse as any);

      const payload: CreateImagePayload = {
        model: 'bytedance-seed/seedream-5-0-lite',
        params: {
          prompt: 'رنگشو قرمز کن',
          imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openrouter', {
        imageEditMode: 'inputReferences',
      });

      // The regression: /images/edits does not exist on OpenRouter and returns 404.
      expect(mockClient.images.edit).not.toHaveBeenCalled();
      expect(mockClient.images.generate).toHaveBeenCalledTimes(1);
      expect(result.imageUrl).toBe('data:image/png;base64,editedViaInputReferences');
    });

    it('sends references as input_references and drops the image field', async () => {
      global.fetch = failIfFetched() as any;
      vi.mocked(mockClient.images.generate).mockResolvedValue(editedResponse as any);

      const payload: CreateImagePayload = {
        model: 'bytedance-seed/seedream-5-0-lite',
        params: {
          prompt: 'make it red',
          imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        },
      };

      await createOpenAICompatibleImage(mockClient, payload, 'openrouter', {
        imageEditMode: 'inputReferences',
      });

      const body = vi.mocked(mockClient.images.generate).mock.calls[0][0] as any;
      expect(body.input_references).toEqual([
        { image_url: { url: 'https://example.com/a.jpg' }, type: 'image_url' },
        { image_url: { url: 'https://example.com/b.jpg' }, type: 'image_url' },
      ]);
      expect(body.image).toBeUndefined();
      expect(body.model).toBe('bytedance-seed/seedream-5-0-lite');
      expect(body.prompt).toBe('make it red');
    });

    it('normalises a single imageUrl string into one input_reference', async () => {
      global.fetch = failIfFetched() as any;
      vi.mocked(mockClient.images.generate).mockResolvedValue(editedResponse as any);

      const payload: CreateImagePayload = {
        model: 'bytedance-seed/seedream-5-0-lite',
        params: { prompt: 'edit', imageUrl: 'https://example.com/one.jpg' },
      };

      await createOpenAICompatibleImage(mockClient, payload, 'openrouter', {
        imageEditMode: 'inputReferences',
      });

      const body = vi.mocked(mockClient.images.generate).mock.calls[0][0] as any;
      expect(body.input_references).toEqual([
        { image_url: { url: 'https://example.com/one.jpg' }, type: 'image_url' },
      ]);
      expect(mockClient.images.edit).not.toHaveBeenCalled();
    });

    it('reports identical modelUsage under both edit transports', async () => {
      const usage = {
        total_tokens: 1000,
        input_tokens: 100,
        output_tokens: 900,
        input_tokens_details: { text_tokens: 50, image_tokens: 50 },
      };
      const params = { prompt: 'same prompt', imageUrls: ['https://example.com/a.jpg'] };

      // input_references transport
      global.fetch = failIfFetched() as any;
      vi.mocked(mockClient.images.generate).mockResolvedValue({
        data: [{ b64_json: 'x' }],
        usage,
      } as any);
      const viaRefs = await createOpenAICompatibleImage(
        mockClient,
        { model: 'm', params },
        'openrouter',
        { imageEditMode: 'inputReferences' },
      );

      // multipart transport
      const mockArrayBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockArrayBuffer,
        headers: { get: (n: string) => (n === 'content-type' ? 'image/jpeg' : null) },
      } as any);
      vi.mocked(mockClient.images.edit).mockResolvedValue({
        data: [{ b64_json: 'x' }],
        usage,
      } as any);
      const viaMultipart = await createOpenAICompatibleImage(
        mockClient,
        { model: 'm', params },
        'openrouter',
      );

      // Billing must not depend on which transport carried the reference image.
      expect(viaRefs.modelUsage).toEqual(viaMultipart.modelUsage);
    });

    it('still uses multipart /images/edits when the mode is not set', async () => {
      const mockArrayBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockArrayBuffer,
        headers: { get: (n: string) => (n === 'content-type' ? 'image/jpeg' : null) },
      } as any);
      vi.mocked(mockClient.images.edit).mockResolvedValue(editedResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-2',
        params: { prompt: 'edit', imageUrls: ['https://example.com/a.jpg'] },
      };

      await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(mockClient.images.edit).toHaveBeenCalled();
      expect(mockClient.images.generate).not.toHaveBeenCalled();
    });
  });

  describe('image mode - usage tracking', () => {
    it('should include modelUsage when usage is present in response', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'imageWithUsage',
          },
        ],
        usage: {
          total_tokens: 1000,
          input_tokens: 100,
          output_tokens: 900,
          input_tokens_details: {
            text_tokens: 50,
            image_tokens: 50,
          },
        },
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Generate image with usage tracking',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,imageWithUsage');
      expect(result.modelUsage).toBeDefined();
      expect(result.modelUsage?.inputImageTokens).toBe(50);
      expect(result.modelUsage?.inputTextTokens).toBe(50);
      expect(result.modelUsage?.outputImageTokens).toBe(900);
    });

    it('should not include modelUsage when usage is missing in response', async () => {
      const mockImageResponse = {
        data: [
          {
            b64_json: 'imageWithoutUsage',
          },
        ],
        // No usage field
      };

      vi.mocked(mockClient.images.generate).mockResolvedValue(mockImageResponse as any);

      const payload: CreateImagePayload = {
        model: 'dall-e-3',
        params: {
          prompt: 'Generate image without usage tracking',
        },
      };

      const result = await createOpenAICompatibleImage(mockClient, payload, 'openai');

      expect(result.imageUrl).toBe('data:image/png;base64,imageWithoutUsage');
      expect(result.modelUsage).toBeUndefined();
    });
  });
});
