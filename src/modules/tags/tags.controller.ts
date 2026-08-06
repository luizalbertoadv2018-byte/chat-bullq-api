import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';

@ApiTags('Tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly service: TagsService) {}

  @Post('conversation/:convId/tag/:tagId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN, OrgRole.AGENT)
  @ApiOperation({ summary: 'Attach tag to conversation' })
  addToConversation(
    @Param('convId') convId: string,
    @Param('tagId') tagId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.addToConversation(convId, tagId, orgId, userId);
  }

  @Delete('conversation/:convId/tag/:tagId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN, OrgRole.AGENT)
  @ApiOperation({ summary: 'Remove tag from conversation' })
  removeFromConversation(
    @Param('convId') convId: string,
    @Param('tagId') tagId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.removeFromConversation(convId, tagId, orgId, userId);
  }

  @Post('contact/:contactId/tag/:tagId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN, OrgRole.AGENT)
  @ApiOperation({ summary: 'Attach tag to contact' })
  addToContact(
    @Param('contactId') contactId: string,
    @Param('tagId') tagId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.addToContact(contactId, tagId, orgId, userId);
  }

  @Delete('contact/:contactId/tag/:tagId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN, OrgRole.AGENT)
  @ApiOperation({ summary: 'Remove tag from contact' })
  removeFromContact(
    @Param('contactId') contactId: string,
    @Param('tagId') tagId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.removeFromContact(contactId, tagId, orgId, userId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create tag' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateTagDto) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List tags' })
  findAll(@CurrentOrg('id') orgId: string) {
    return this.service.findAll(orgId);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update tag' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Delete tag' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
