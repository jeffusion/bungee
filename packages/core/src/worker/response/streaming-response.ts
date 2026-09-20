export function isStreamingResponse(response: Response): boolean {
  return Boolean(
    response.body
      && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'),
  );
}
