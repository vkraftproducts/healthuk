import { Controller, Get } from '@nestjs/common';
import { buildOpenApi } from '@hub/contracts';
import { Public } from '../common/decorators.js';

@Controller()
export class OpenApiController {
  @Public()
  @Get('openapi.json')
  spec() {
    return buildOpenApi();
  }
}
