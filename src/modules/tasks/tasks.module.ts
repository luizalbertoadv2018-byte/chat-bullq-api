import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskCalendarService } from './task-calendar.service';

@Module({
  imports: [PrismaModule],
  controllers: [TasksController],
  providers: [TasksService, TaskCalendarService],
  exports: [TasksService],
})
export class TasksModule {}
