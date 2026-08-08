import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto, ListTasksQueryDto } from './dto/task.dto';

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  @ApiOperation({ summary: 'Lista tarefas do escritório (com filtros)' })
  list(@CurrentOrg('id') orgId: string, @Query() query: ListTasksQueryDto) {
    return this.service.list(orgId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de uma tarefa' })
  findOne(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Cria uma tarefa' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateTaskDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza uma tarefa' })
  update(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove (soft-delete) uma tarefa' })
  remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }
}
