#!/usr/bin/env ruby
# frozen_string_literal: true

require "ripper"

module FormulaVersion
  class ValidationError < StandardError; end

  SEMVER = /\A\d+\.\d+\.\d+\z/
  RAW_DECLARATION = /\A[ \t]*version[ \t]+/
  CANONICAL_DECLARATION = /\A  version "(\d+\.\d+\.\d+)"\z/
  FORBIDDEN_DYNAMIC_METHODS = %w[
    __send__
    alias_method
    attr
    attr_accessor
    attr_reader
    attr_writer
    class_eval
    define_method
    define_singleton_method
    eval
    instance_eval
    module_eval
    public_send
    remove_method
    send
    undef_method
  ].freeze

  module_function

  def extract(path)
    source = File.read(path, encoding: "UTF-8")
    raw_declarations = source.lines.each_with_index.map do |line, zero_based_line|
      text = line.delete_suffix("\n").delete_suffix("\r")
      [text, zero_based_line + 1] if RAW_DECLARATION.match?(text)
    end.compact

    unless raw_declarations.length == 1
      raise ValidationError,
            "#{path} must contain exactly one canonical version declaration; " \
            "found #{raw_declarations.length} declaration-like lines"
    end

    raw_text, raw_line = raw_declarations.fetch(0)
    raw_match = CANONICAL_DECLARATION.match(raw_text)
    unless raw_match
      raise ValidationError,
            "#{path}:#{raw_line} is not the canonical two-space version \"X.Y.Z\" declaration"
    end

    syntax_tree = Ripper.sexp(source)
    raise ValidationError, "#{path} is not valid Ruby" unless syntax_tree

    formula_class = direct_formula_class(syntax_tree, path)
    setters = []
    collect_version_setters(syntax_tree, setters)
    unless setters.length == 1
      raise ValidationError,
            "#{path} must contain exactly one canonical version declaration; " \
            "Ruby parsed #{setters.length} active version setters"
    end

    command = setters.fetch(0)
    unless direct_class_statement?(formula_class, command)
      raise ValidationError,
            "#{path}:#{raw_line} version declaration must be a direct Formula class statement"
    end
    parsed_version = static_string_argument(command)
    command_line = command.dig(1, 2, 0)
    unless parsed_version&.match?(SEMVER) && parsed_version == raw_match[1] && command_line == raw_line
      raise ValidationError,
            "#{path}:#{raw_line} must be one active version \"X.Y.Z\" command with a static string"
    end

    parsed_version
  rescue Errno::ENOENT, Errno::EACCES => error
    raise ValidationError, error.message
  end

  def compare(left, right)
    left.split(".").map!(&:to_i) <=> right.split(".").map!(&:to_i)
  end

  def assert_advance(candidate_path, baseline_path)
    candidate = extract(candidate_path)
    baseline = extract(baseline_path)
    unless compare(candidate, baseline).positive?
      raise ValidationError,
            "Formula candidate version #{candidate} must be strictly greater than baseline #{baseline}"
    end

    warn "Formula advancement validated: #{baseline} -> #{candidate}."
  end

  def assert_target_advance(target, baseline_path)
    raise ValidationError, "Target version #{target.inspect} is not X.Y.Z" unless SEMVER.match?(target)

    baseline = extract(baseline_path)
    unless compare(target, baseline).positive?
      raise ValidationError,
            "Formula target version #{target} must be strictly greater than baseline #{baseline}"
    end

    warn "Formula advancement validated: #{baseline} -> #{target}."
  end

  def assert_version(path, expected)
    raise ValidationError, "Expected version #{expected.inspect} is not X.Y.Z" unless SEMVER.match?(expected)

    actual = extract(path)
    return if actual == expected

    raise ValidationError, "#{path} declares version #{actual}, expected #{expected}"
  end

  def collect_version_setters(node, setters)
    return unless node.is_a?(Array)

    reject_version_redefinition(node)
    version_setter = case node[0]
                     when :command
                       node.dig(1, 0) == :@ident && node.dig(1, 1) == "version"
                     when :command_call
                       node.dig(3, 0) == :@ident && node.dig(3, 1) == "version"
                     when :method_add_arg
                       method = node[1]
                       (method&.dig(0) == :fcall && method.dig(1, 0) == :@ident &&
                         method.dig(1, 1) == "version") ||
                         (method&.dig(0) == :call && method.dig(3, 0) == :@ident &&
                           method.dig(3, 1) == "version")
                     else
                       false
                     end
    setters << node if version_setter

    if FORBIDDEN_DYNAMIC_METHODS.include?(called_method_name(node))
      raise ValidationError,
            "Formula version validation does not allow dynamic Ruby evaluation or method definition"
    end
    node.each { |child| collect_version_setters(child, setters) if child.is_a?(Array) }
  end

  def direct_formula_class(syntax_tree, path)
    classes = []
    collect_formula_classes(syntax_tree, classes)
    unless classes.length == 1
      raise ValidationError,
            "#{path} must contain exactly one Formula subclass; found #{classes.length}"
    end

    formula_class = classes.fetch(0)
    top_level_statements = syntax_tree[1]
    unless top_level_statements.is_a?(Array) &&
           top_level_statements.any? { |statement| statement.equal?(formula_class) }
      raise ValidationError, "#{path} Formula subclass must be a direct top-level statement"
    end
    formula_class
  end

  def collect_formula_classes(node, classes)
    return unless node.is_a?(Array)

    classes << node if node[0] == :class && formula_superclass?(node[2])
    node.each { |child| collect_formula_classes(child, classes) if child.is_a?(Array) }
  end

  def formula_superclass?(node)
    (node&.dig(0) == :var_ref || node&.dig(0) == :top_const_ref) &&
      node.dig(1, 0) == :@const && node.dig(1, 1) == "Formula"
  end

  def direct_class_statement?(formula_class, statement)
    body = formula_class[3]
    body&.dig(0) == :bodystmt &&
      body[1].is_a?(Array) &&
      body[1].any? { |candidate| candidate.equal?(statement) }
  end

  def reject_version_redefinition(node)
    redefines = case node[0]
                when :def
                  node.dig(1, 1) == "version"
                when :defs
                  node.dig(3, 1) == "version"
                when :alias, :var_alias, :undef
                  true
                else
                  false
                end
    raise ValidationError, "Formula must not redefine version" if redefines
  end

  def called_method_name(node)
    case node[0]
    when :command, :fcall, :vcall
      node.dig(1, 1)
    when :command_call, :call
      node.dig(3, 1)
    when :method_add_arg
      called_method_name(node[1])
    end
  end

  def static_string_argument(command)
    arguments = command[2]
    return unless arguments.is_a?(Array) && arguments[0] == :args_add_block
    return unless arguments[2] == false

    values = arguments[1]
    return unless values.is_a?(Array) && values.length == 1

    string = values.fetch(0)
    return unless string.is_a?(Array) && string[0] == :string_literal

    content = string[1]
    return unless content.is_a?(Array) && content[0] == :string_content && content.length == 2

    token = content[1]
    return unless token.is_a?(Array) && token[0] == :@tstring_content

    token[1]
  end
end

begin
  command = ARGV.shift
  case command
  when "extract"
    abort "usage: formula-version.rb extract FORMULA" unless ARGV.length == 1

    puts FormulaVersion.extract(ARGV.fetch(0))
  when "assert-advance"
    abort "usage: formula-version.rb assert-advance CANDIDATE BASELINE" unless ARGV.length == 2

    FormulaVersion.assert_advance(ARGV.fetch(0), ARGV.fetch(1))
  when "assert-target-advance"
    abort "usage: formula-version.rb assert-target-advance VERSION BASELINE" unless ARGV.length == 2

    FormulaVersion.assert_target_advance(ARGV.fetch(0), ARGV.fetch(1))
  when "assert-version"
    abort "usage: formula-version.rb assert-version FORMULA VERSION" unless ARGV.length == 2

    FormulaVersion.assert_version(ARGV.fetch(0), ARGV.fetch(1))
  else
    abort "usage: formula-version.rb {extract|assert-advance|assert-target-advance|assert-version} ..."
  end
rescue FormulaVersion::ValidationError => error
  warn "formula-version: #{error.message}"
  exit 1
end
