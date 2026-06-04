<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let expression = '';
  export let label = 'Expression';
  export let placeholder = 'Enter expression...';
  export let testData: any = null;

  const dispatch = createEventDispatcher();

  let showTemplates = false;
  let testResult: any = null;
  let testError: string | null = null;

  // 常用表达式模板
  const templates = [
    {
      name: 'Match Header',
      description: 'Check if header exists and matches value',
      expression: 'req.headers["x-api-key"] === "secret"',
    },
    {
      name: 'Path Prefix',
      description: 'Check if path starts with prefix',
      expression: 'req.url.pathname.startsWith("/api")',
    },
    {
      name: 'Method Check',
      description: 'Check HTTP method',
      expression: 'req.method === "POST"',
    },
    {
      name: 'Query Parameter',
      description: 'Check query parameter value',
      expression: 'new URL(req.url).searchParams.get("version") === "v2"',
    },
    {
      name: 'Response Status',
      description: 'Check response status code',
      expression: 'res.status === 200',
    },
    {
      name: 'Response Header',
      description: 'Check response header',
      expression: 'res.headers["content-type"].includes("json")',
    },
    {
      name: 'Body Content',
      description: 'Check if body contains text',
      expression: 'body.includes("error")',
    },
    {
      name: 'JSON Field',
      description: 'Access JSON field in body',
      expression: 'JSON.parse(body).status === "ok"',
    },
  ];

  function insertTemplate(template: typeof templates[0]) {
    expression = template.expression;
    showTemplates = false;
    handleChange();
  }

  function handleChange() {
    dispatch('change', expression);
    testResult = null;
    testError = null;
  }

  function testExpression() {
    if (!expression || !testData) {
      testError = 'Please provide both expression and test data';
      return;
    }

    try {
      // 简单的表达式测试（实际应该调用后端 API）
      // 这里只做基本的语法检查
      const func = new Function('req', 'res', 'body', `return ${expression}`);

      // 模拟测试
      const mockReq = testData.req || {
        url: 'http://localhost/test',
        method: 'GET',
        headers: {}
      };
      const mockRes = testData.res || { status: 200, headers: {} };
      const mockBody = testData.body || '';

      const result = func(mockReq, mockRes, mockBody);
      testResult = {
        success: true,
        value: result,
        type: typeof result
      };
      testError = null;
    } catch (err: any) {
      testError = err.message;
      testResult = null;
    }
  }

  function clearTest() {
    testResult = null;
    testError = null;
  }
</script>

<div class="space-y-2">
  <div class="flex justify-between items-center">
    <label class="block">
      <span class="nx-label-sm font-semibold">{label}</span>
    </label>
    <button
      type="button"
      class="nx-btn-outline nx-btn-sm"
      on:click={() => showTemplates = !showTemplates}
    >
      {showTemplates ? 'Hide' : 'Show'} Templates
    </button>
  </div>

  {#if showTemplates}
    <div class="bg-carbon-950/60 p-3 rounded-lg space-y-2 max-h-60 overflow-y-auto">
      <p class="text-xs font-semibold text-gray-600">Expression Templates</p>
      {#each templates as template}
        <button
          type="button"
          class="block w-full text-left p-2 hover:bg-carbon-700 rounded text-sm"
          on:click={() => insertTemplate(template)}
        >
          <div class="font-medium">{template.name}</div>
          <div class="text-xs text-zinc-500">{template.description}</div>
          <code class="text-xs bg-carbon-950 px-1 rounded">{template.expression}</code>
        </button>
      {/each}
    </div>
  {/if}

  <textarea
    class="nx-input py-2 resize-y font-mono text-sm w-full"
    bind:value={expression}
    on:input={handleChange}
    {placeholder}
    rows="3"
  ></textarea>

  {#if testData}
    <div class="flex gap-2">
      <button
        type="button"
        class="nx-btn-outline nx-btn-sm"
        on:click={testExpression}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Test Expression
      </button>
      {#if testResult || testError}
        <button
          type="button"
          class="nx-btn-ghost nx-btn-sm"
          on:click={clearTest}
        >
          Clear
        </button>
      {/if}
    </div>

    {#if testError}
      <div class="border-l-2 border-l-red-500 bg-red-500/5 px-3 py-2 flex items-center gap-2 text-red-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-4 w-4" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-xs">Error: {testError}</span>
      </div>
    {/if}

    {#if testResult}
      <div class="border-l-2 border-l-emerald-500 bg-emerald-500/5 px-3 py-2 flex items-center gap-2 text-emerald-300">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-4 w-4" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-xs">
          Result: <code class="bg-carbon-950 px-1 rounded">{JSON.stringify(testResult.value)}</code>
          <span class="text-zinc-500">({testResult.type})</span>
        </span>
      </div>
    {/if}
  {/if}

  <p class="text-xs text-zinc-500">
    Available variables: <code>req</code> (request), <code>res</code> (response), <code>body</code> (response body)
  </p>
</div>
