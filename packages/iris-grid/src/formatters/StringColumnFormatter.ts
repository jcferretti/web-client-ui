/* eslint class-methods-use-this: "off" */
import TableColumnFormatter from './TableColumnFormatter';

/** Column formatter for strings */
class StringColumnFormatter extends TableColumnFormatter<string> {
  format(value: string): string {
    return value;
  }
}

export default StringColumnFormatter;
