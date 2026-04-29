import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToMany,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Business } from './business.entity';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ unique: true, length: 120 })
  @Index()
  slug: string;

  @Column({ nullable: true })
  description: string | null;

  @Column({ nullable: true })
  icon: string | null;

  /** Self-referential: top-level categories have null parent */
  @Column({ nullable: true })
  parent_id: string | null;

  @ManyToOne(() => Category, (cat) => cat.children, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Category | null;

  @OneToMany(() => Category, (cat) => cat.parent)
  children: Category[];

  @ManyToMany(() => Business, (biz) => biz.categories)
  businesses: Business[];

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
