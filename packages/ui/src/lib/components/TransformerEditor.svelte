<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { TransformersAPI } from '../api/transformers';

  export let transformer: string | null = null;
  export let label = 'Transformer';

  const dispatch = createEventDispatcher();

  let showPreview = false;
  let testRequest = `{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}`;
  let testResponse = '';
  let previewError: string | null = null;

  // 可用的 transformers (动态从API获取)
  let availableTransformers: Array<{
    id: string;
    name: string;
    description: string;
  }> = [];

  // 格式化transformer名称
  function formatTransformerName(id: string): string {
    return id.split('-').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' → ');
  }

  // 获取transformer描述
  function getTransformerDescription(id: string): string {
    const parts = id.split('-to-');
    if (parts.length === 2) {
      const [from, to] = parts;
      return `Convert ${from.charAt(0).toUpperCase() + from.slice(1)} API format to ${to.charAt(0).toUpperCase() + to.slice(1)} format`;
    }
    return `${formatTransformerName(id)} transformer`;
  }

  // 从API获取transformers列表
  onMount(async () => {
    try {
      const transformerIds = await TransformersAPI.getAll();
      availableTransformers = transformerIds.map(id => ({
        id,
        name: formatTransformerName(id),
        description: getTransformerDescription(id)
      }));
    } catch (error) {
      console.warn('Failed to load transformers from API, using fallback:', error);
      // 如果API失败，使用备用列表
      availableTransformers = [
        {
          id: 'openai-to-anthropic',
          name: 'OpenAI → Anthropic',
          description: 'Convert OpenAI API format to Anthropic format',
        },
        {
          id: 'anthropic-to-openai',
          name: 'Anthropic → OpenAI',
          description: 'Convert Anthropic API format to OpenAI format',
        },
        {
          id: 'anthropic-to-gemini',
          name: 'Anthropic → Gemini',
          description: 'Convert Anthropic API format to Google Gemini format',
        }
      ];
    }
  });

  function handleChange() {
    dispatch('change', transformer);
    testResponse = '';
    previewError = null;
  }

  function previewTransform() {
    if (!transformer || !testRequest) {
      previewError = 'Please select a transformer and provide test data';
      return;
    }

    try {
      const input = JSON.parse(testRequest);

      // 模拟转换（实际应该调用后端 API）
      let output;

      if (transformer === 'anthropic-to-gemini') {
        output = {
          contents: input.messages?.map((msg: any) => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
          })),
          generationConfig: {
            temperature: input.temperature || 1.0,
            maxOutputTokens: input.max_tokens || 8192
          }
        };
      } else if (transformer === 'anthropic-to-openai') {
        output = {
          model: input.model?.replace('claude', 'gpt-4'),
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.max_tokens
        };
      } else {
        output = { ...input, _transformed: true };
      }

      testResponse = JSON.stringify(output, null, 2);
      previewError = null;
    } catch (err: any) {
      previewError = err.message;
      testResponse = '';
    }
  }

  function clearPreview() {
    testResponse = '';
    previewError = null;
  }
</script>

<div class="space-y-3">
  <div class="form-control">
    <label class="label">
      <span class="label-text font-semibold">{label}</span>
    </label>
    <select
      class="select select-bordered"
      bind:value={transformer}
      on:change={handleChange}
    >
      <option value={null}>None (Direct proxy)</option>
      {#each availableTransformers as t}
        <option value={t.id}>{t.name}</option>
      {/each}
    </select>
    {#if transformer}
      <label class="label">
        <span class="label-text-alt text-gray-500">
          {availableTransformers.find(t => t.id === transformer)?.description}
        </span>
      </label>
    {/if}
  </div>

  {#if transformer}
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="btn btn-xs btn-outline"
        on:click={() => showPreview = !showPreview}
      >
        {showPreview ? 'Hide' : 'Show'} Preview
      </button>
    </div>

    {#if showPreview}
      <div class="card bg-base-200">
        <div class="card-body p-4 space-y-3">
          <h4 class="font-semibold text-sm">API Format Transformation Preview</h4>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label py-1">
                <span class="label-text text-xs">Input (Original Format)</span>
              </label>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono text-xs w-full"
                bind:value={testRequest}
                rows="10"
              ></textarea>
            </div>

            <div>
              <label class="label py-1">
                <span class="label-text text-xs">Output (Transformed Format)</span>
              </label>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono text-xs w-full bg-base-100"
                value={testResponse}
                readonly
                rows="10"
                placeholder="Click 'Test Transform' to see output"
              ></textarea>
            </div>
          </div>

          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-xs btn-primary"
              on:click={previewTransform}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
              Test Transform
            </button>
            {#if testResponse || previewError}
              <button
                type="button"
                class="btn btn-xs btn-ghost"
                on:click={clearPreview}
              >
                Clear
              </button>
            {/if}
          </div>

          {#if previewError}
            <div class="alert alert-error py-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-4 w-4" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-xs">Error: {previewError}</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
