import { createServer } from 'node:http';
import {
  guardedStreamFrom,
  RepresentationMetadata,
  type MetadataWriter,
  type MetadataWriterInput,
} from '@solid/community-server';
import { HeadSafeResponseWriter } from '../../src/http/HeadSafeResponseWriter';

const metadataWriter = {
  async handleSafe({ response }: MetadataWriterInput) {
    response.setHeader('Content-Type', 'text/plain');
  },
} as unknown as MetadataWriter;
const writer = new HeadSafeResponseWriter(metadataWriter);
const server = createServer((_request, response) => {
  const metadata = new RepresentationMetadata();
  metadata.contentType = 'text/plain';
  void writer.handleSafe({
    response,
    result: { statusCode: 404, metadata, data: guardedStreamFrom('NotFoundHttpError: \n') },
  }).catch((error: Error) => response.destroy(error));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
  }
});
